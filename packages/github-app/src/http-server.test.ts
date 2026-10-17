import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createGitHubWebhookServer } from "./http-server.js";
import { InMemoryJobQueue } from "./queue.js";
import { createGitHubWebhookSignature } from "./signature.js";
import { GitHubWebhookService } from "./webhook.js";
import { QueueWorker } from "./worker.js";
import { BillingSafetyCheckExecutor } from "./check-executor.js";

const secret = "synthetic-webhook-secret-for-http-tests";

describe("GitHub webhook HTTP server", () => {
  it("exposes a minimal health check and rejects unsigned requests", async () => {
    const queue = new InMemoryJobQueue();
    const worker = new QueueWorker(queue, new BillingSafetyCheckExecutor({
      forInstallation: () => { throw new Error("not used"); },
    }), { write: () => undefined });
    const server = createGitHubWebhookServer({
      service: new GitHubWebhookService(secret, queue),
      worker,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener");
    }

    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const rejected = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
        method: "POST",
        headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery" },
        body: "{}",
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ status: "rejected", reason: "invalid_signature" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("accepts a valid signed delivery and schedules the local queue worker", async () => {
    const queue = new InMemoryJobQueue();
    const completed: string[] = [];
    const executor = new BillingSafetyCheckExecutor({
      forInstallation: () => ({
        getPullRequest: async () => ({ headSha: "a".repeat(40), baseRepositoryId: 42 }),
        createCheckRun: async (input) => {
          completed.push(`started:${input.headSha}`);
          return { id: 77 };
        },
        completeCheckRun: async (input) => {
          completed.push(`completed:${input.conclusion}`);
        },
      }),
    });
    const worker = new QueueWorker(queue, executor, { write: () => undefined });
    const server = createGitHubWebhookServer({
      service: new GitHubWebhookService(secret, queue),
      worker,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener");
    }
    const body = Buffer.from(JSON.stringify({
      action: "opened",
      installation: { id: 9 },
      repository: { id: 42, full_name: "sample-org/sample-repo" },
      number: 5,
      pull_request: {
        updated_at: "2026-10-17T12:00:00Z",
        head: { sha: "a".repeat(40), repo: { id: 42 } },
      },
    }));

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "00000000-0000-4000-8000-000000000031",
          "x-hub-signature-256": createGitHubWebhookSignature(body, secret),
        },
        body,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "queued" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completed).toEqual([`started:${"a".repeat(40)}`, "completed:neutral"]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
