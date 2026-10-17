import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "./queue.js";
import { createGitHubWebhookSignature } from "./signature.js";
import { GitHubWebhookService } from "./webhook.js";

const secret = "synthetic-webhook-secret-for-unit-tests";
const deliveryId = "00000000-0000-4000-8000-000000000011";
const currentSha = "a".repeat(40);

function payload(action = "opened", overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    action,
    installation: { id: 123 },
    repository: { id: 456, full_name: "sample-org/sample-repo" },
    number: 9,
    pull_request: {
      updated_at: "2026-10-17T12:00:00Z",
      head: { sha: currentSha, repo: { id: 456 } },
    },
    ...overrides,
  }));
}

function headers(body: Buffer, event = "pull_request", id = deliveryId, signingSecret = secret) {
  return {
    "x-hub-signature-256": createGitHubWebhookSignature(body, signingSecret),
    "x-github-event": event,
    "x-github-delivery": id,
  };
}

describe("GitHub PR webhook service", () => {
  it("authenticates and queues opened, synchronize, and reopened events with the exact head SHA", async () => {
    for (const [index, action] of ["opened", "synchronize", "reopened"].entries()) {
      const queue = new InMemoryJobQueue();
      const service = new GitHubWebhookService(secret, queue);
      const body = payload(action);
      const response = await service.receive(body, headers(
        body,
        "pull_request",
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ));
      const job = await queue.claimNext();

      expect(response.statusCode).toBe(202);
      expect(response.status).toBe("queued");
      expect(job?.action).toBe(action);
      expect(job?.headSha).toBe(currentSha);
      expect(job?.installationId).toBe(123);
      expect(job?.repositoryId).toBe(456);
      expect(job?.pullRequestNumber).toBe(9);
    }
  });

  it("rejects invalid signatures before parsing or queueing payloads", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const body = payload();
    const response = await service.receive(body, {
      ...headers(body),
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.reason).toBe("invalid_signature");
    expect(queue.pendingCount()).toBe(0);
  });

  it("rejects malformed JSON and structurally invalid pull request payloads", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const invalidJson = Buffer.from("{");
    const invalidPayload = Buffer.from(JSON.stringify({ action: "opened" }));

    expect((await service.receive(invalidJson, headers(invalidJson))).reason).toBe("invalid_json");
    expect((await service.receive(invalidPayload, headers(invalidPayload))).reason).toBe("invalid_payload");
    expect(queue.pendingCount()).toBe(0);
  });

  it("ignores unrelated events and pull request actions", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const body = payload("closed");

    expect((await service.receive(body, headers(body, "push"))).status).toBe("ignored");
    expect((await service.receive(body, headers(body))).status).toBe("ignored");
    expect(queue.pendingCount()).toBe(0);
  });

  it("marks fork pull requests as untrusted without rejecting the signed event", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const body = payload("opened", {
      pull_request: {
        updated_at: "2026-10-17T12:00:00Z",
        head: { sha: currentSha, repo: { id: 999 } },
      },
    });

    expect((await service.receive(body, headers(body))).status).toBe("queued");
    expect((await queue.claimNext())?.isFork).toBe(true);
  });

  it("handles repeated GitHub delivery IDs idempotently", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const body = payload();
    const eventHeaders = headers(body);

    expect((await service.receive(body, eventHeaders)).status).toBe("queued");
    const duplicate = await service.receive(body, eventHeaders);
    expect(duplicate.status).toBe("duplicate");
    expect(queue.pendingCount()).toBe(1);
  });

  it("allows a new reopened delivery on the same SHA but rejects its redelivery", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const openedBody = payload("opened");
    expect((await service.receive(openedBody, headers(openedBody, "pull_request", deliveryId))).status).toBe("queued");
    const opened = await queue.claimNext();
    expect(opened?.headSha).toBe(currentSha);
    if (opened) await queue.mark(opened, "completed");

    const reopenedBody = payload("reopened", {
      pull_request: {
        updated_at: "2026-10-17T12:01:00Z",
        head: { sha: currentSha, repo: { id: 456 } },
      },
    });
    const reopenedHeaders = headers(
      reopenedBody,
      "pull_request",
      "00000000-0000-4000-8000-000000000012",
    );

    expect((await service.receive(reopenedBody, reopenedHeaders)).status).toBe("queued");
    expect((await service.receive(reopenedBody, reopenedHeaders)).status).toBe("duplicate");
    expect(queue.pendingCount()).toBe(1);
    expect((await queue.claimNext())?.action).toBe("reopened");
  });

  it("collapses concurrent distinct deliveries for one reopened lifecycle", async () => {
    const queue = new InMemoryJobQueue();
    const service = new GitHubWebhookService(secret, queue);
    const openedBody = payload("opened");
    const opened = await service.receive(openedBody, headers(openedBody, "pull_request", deliveryId));
    expect(opened.status).toBe("queued");
    const openedJob = await queue.claimNext();
    if (openedJob) await queue.mark(openedJob, "completed");

    const reopenedBody = payload("reopened", {
      pull_request: {
        updated_at: "2026-10-17T12:01:00Z",
        head: { sha: currentSha, repo: { id: 456 } },
      },
    });
    const responses = await Promise.all([12, 13, 14].map((suffix) =>
      service.receive(
        reopenedBody,
        headers(reopenedBody, "pull_request", `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`),
      ),
    ));

    expect(responses.filter((response) => response.status === "queued")).toHaveLength(1);
    expect(responses.filter((response) => response.status === "duplicate")).toHaveLength(2);
    expect(queue.pendingCount()).toBe(1);
  });
});
