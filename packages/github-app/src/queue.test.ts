import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "./queue.js";
import type { PullRequestJob } from "./model.js";

const firstSha = "a".repeat(40);
const secondSha = "b".repeat(40);

function createJob(overrides: Partial<PullRequestJob> = {}): PullRequestJob {
  return {
    deliveryId: "00000000-0000-4000-8000-000000000001",
    installationId: 100,
    repositoryId: 200,
    repositoryFullName: "sample-org/sample-repo",
    owner: "sample-org",
    repositoryName: "sample-repo",
    pullRequestNumber: 7,
    headSha: firstSha,
    action: "opened",
    updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    isFork: false,
    ...overrides,
  };
}

describe("in-memory GitHub job queue", () => {
  it("queues a delivery once and rejects duplicate delivery IDs", async () => {
    const queue = new InMemoryJobQueue();
    const job = createJob();

    expect((await queue.enqueue(job)).status).toBe("queued");
    expect((await queue.enqueue(job)).status).toBe("duplicate_delivery");
    expect(queue.pendingCount()).toBe(1);
  });

  it("deduplicates distinct deliveries for the same repository, PR, and head SHA", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(createJob());
    const result = await queue.enqueue(createJob({
      deliveryId: "00000000-0000-4000-8000-000000000002",
      action: "synchronize",
    }));

    expect(result.status).toBe("duplicate_head");
    expect(queue.pendingCount()).toBe(1);
  });

  it("ignores an older event after a newer head update has been observed", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(createJob({
      deliveryId: "00000000-0000-4000-8000-000000000002",
      headSha: secondSha,
      action: "synchronize",
      updatedAt: Date.parse("2026-01-01T00:00:10.000Z"),
    }));
    const result = await queue.enqueue(createJob());

    expect(result.status).toBe("stale_event");
    expect(queue.pendingCount()).toBe(1);
  });

  it("records worker lifecycle state", async () => {
    const queue = new InMemoryJobQueue();
    const job = createJob();
    await queue.enqueue(job);

    expect((await queue.claimNext())?.headSha).toBe(firstSha);
    expect(queue.statusFor(job)).toBe("running");
    await queue.mark(job, "completed");
    expect(queue.statusFor(job)).toBe("completed");
  });
});
