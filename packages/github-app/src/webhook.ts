import { z } from "zod";
import type { JobQueue, PullRequestJob } from "./model.js";
import { SUPPORTED_PULL_REQUEST_ACTIONS } from "./model.js";
import { verifyGitHubWebhookSignature } from "./signature.js";

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const DELIVERY_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const repositoryNamePattern = /^[^/\s]+\/[^/\s]+$/;

const PositiveIdSchema = z.number().int().positive().safe();
const PullRequestEventSchema = z.object({
  action: z.enum(SUPPORTED_PULL_REQUEST_ACTIONS),
  installation: z.object({ id: PositiveIdSchema }),
  repository: z.object({
    id: PositiveIdSchema,
    full_name: z.string().regex(repositoryNamePattern),
  }),
  number: PositiveIdSchema,
  pull_request: z.object({
    updated_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    head: z.object({
      sha: z.string().regex(SHA_PATTERN),
      repo: z.object({ id: PositiveIdSchema }).nullable().optional(),
    }),
  }),
});

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface WebhookResult {
  statusCode: 202 | 400 | 401 | 503;
  status: "queued" | "duplicate" | "stale" | "ignored" | "rejected" | "unavailable";
  reason?: string;
  wakeWorker: boolean;
}

function singleHeader(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function rejected(reason: string, statusCode: 400 | 401): WebhookResult {
  return { statusCode, status: "rejected", reason, wakeWorker: false };
}

function createJob(
  payload: z.infer<typeof PullRequestEventSchema>,
  deliveryId: string,
): PullRequestJob {
  const [owner, repositoryName] = payload.repository.full_name.split("/");
  const headRepositoryId = payload.pull_request.head.repo?.id;

  return {
    deliveryId,
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repositoryFullName: payload.repository.full_name,
    owner: owner!,
    repositoryName: repositoryName!,
    pullRequestNumber: payload.number,
    headSha: payload.pull_request.head.sha,
    action: payload.action,
    updatedAt: Date.parse(payload.pull_request.updated_at),
    isFork: headRepositoryId === undefined || headRepositoryId !== payload.repository.id,
  };
}

/** Authenticates, validates, filters, and queues GitHub PR deliveries. */
export class GitHubWebhookService {
  constructor(
    private readonly webhookSecret: string,
    private readonly queue: JobQueue,
  ) {}

  async receive(rawBody: Buffer, headers: WebhookHeaders): Promise<WebhookResult> {
    const signature = singleHeader(headers, "x-hub-signature-256");
    if (!verifyGitHubWebhookSignature(rawBody, signature, this.webhookSecret)) {
      return rejected("invalid_signature", 401);
    }

    const eventName = singleHeader(headers, "x-github-event");
    if (!eventName) {
      return rejected("missing_event_header", 400);
    }
    if (eventName !== "pull_request") {
      return { statusCode: 202, status: "ignored", reason: "unsupported_event", wakeWorker: false };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return rejected("invalid_json", 400);
    }

    const actionResult = z.object({ action: z.string() }).safeParse(decoded);
    if (!actionResult.success) {
      return rejected("invalid_payload", 400);
    }
    if (!SUPPORTED_PULL_REQUEST_ACTIONS.includes(actionResult.data.action as (typeof SUPPORTED_PULL_REQUEST_ACTIONS)[number])) {
      return { statusCode: 202, status: "ignored", reason: "unsupported_pull_request_action", wakeWorker: false };
    }

    const deliveryId = singleHeader(headers, "x-github-delivery");
    if (!deliveryId || !DELIVERY_PATTERN.test(deliveryId)) {
      return rejected("invalid_delivery_id", 400);
    }

    const parsed = PullRequestEventSchema.safeParse(decoded);
    if (!parsed.success) {
      return rejected("invalid_payload", 400);
    }

    try {
      const result = await this.queue.enqueue(createJob(parsed.data, deliveryId));
      if (result.status === "queued") {
        return { statusCode: 202, status: "queued", wakeWorker: true };
      }
      if (result.status === "stale_event") {
        return { statusCode: 202, status: "stale", reason: "older_pull_request_update", wakeWorker: false };
      }
      return { statusCode: 202, status: "duplicate", reason: result.status, wakeWorker: false };
    } catch {
      return { statusCode: 503, status: "unavailable", reason: "queue_unavailable", wakeWorker: false };
    }
  }
}
