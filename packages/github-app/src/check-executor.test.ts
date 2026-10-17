import { describe, expect, it, vi } from "vitest";
import { BillingSafetyCheckExecutor } from "./check-executor.js";
import { GitHubApiOperationError, safeFailureLog, toSafeGitHubApiError } from "./errors.js";
import type { GitHubRepositoryApi, PullRequestJob } from "./model.js";
import { InMemoryJobQueue } from "./queue.js";
import { QueueWorker } from "./worker.js";

const sha = "c".repeat(40);

function createJob(overrides: Partial<PullRequestJob> = {}): PullRequestJob {
  return {
    deliveryId: "00000000-0000-4000-8000-000000000021",
    installationId: 10,
    repositoryId: 20,
    repositoryFullName: "sample-org/sample-repo",
    owner: "sample-org",
    repositoryName: "sample-repo",
    pullRequestNumber: 3,
    headSha: sha,
    action: "opened",
    updatedAt: Date.parse("2026-01-01T00:00:00Z"),
    isFork: false,
    ...overrides,
  };
}

function createApi(overrides: Partial<GitHubRepositoryApi> = {}): GitHubRepositoryApi {
  return {
    getPullRequest: vi.fn().mockResolvedValue({ headSha: sha, baseRepositoryId: 20 }),
    createCheckRun: vi.fn().mockResolvedValue({ id: 900 }),
    completeCheckRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("billing safety check executor", () => {
  it("creates in_progress then neutral on the exact current PR head without billing claims", async () => {
    const api = createApi();
    const factory = { forInstallation: vi.fn().mockReturnValue(api) };
    const executor = new BillingSafetyCheckExecutor(factory, () => new Date("2026-10-17T12:00:00Z"));
    const job = createJob();

    expect(await executor.execute(job)).toBe("completed");
    expect(factory.forInstallation).toHaveBeenCalledWith({ installationId: 10, repositoryId: 20 });
    expect(api.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "in_progress",
      name: "PayPath CI / Billing Safety",
      headSha: sha,
      startedAt: "2026-10-17T12:00:00.000Z",
    }));
    expect(api.completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      checkRunId: 900,
      conclusion: "neutral",
      summary: "GitHub integration verified. Customer billing tests are not configured or executed.",
    }));
    const completedCheck = vi.mocked(api.completeCheckRun).mock.calls[0]?.[0];
    expect(completedCheck?.summary).not.toMatch(/billing tests passed|billing safety passed/i);
  });

  it("uses action_required for fork PRs and states that no untrusted code ran", async () => {
    const api = createApi();
    const executor = new BillingSafetyCheckExecutor({ forInstallation: () => api });

    await executor.execute(createJob({ isFork: true }));

    expect(api.completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      conclusion: "action_required",
      summary: expect.stringContaining("does not check out or execute untrusted pull request code"),
    }));
  });

  it("does not create a Check Run when the event SHA is stale", async () => {
    const api = createApi({
      getPullRequest: vi.fn().mockResolvedValue({ headSha: "d".repeat(40), baseRepositoryId: 20 }),
    });
    const executor = new BillingSafetyCheckExecutor({ forInstallation: () => api });

    expect(await executor.execute(createJob())).toBe("stale");
    expect(api.createCheckRun).not.toHaveBeenCalled();
  });

  it("creates only one Check Run effect for duplicate deliveries of the same head", async () => {
    const queue = new InMemoryJobQueue();
    const job = createJob();
    await queue.enqueue(job);
    expect((await queue.enqueue({
      ...job,
      deliveryId: "00000000-0000-4000-8000-000000000022",
      action: "synchronize",
    })).status).toBe("duplicate_head");

    const api = createApi();
    const worker = new QueueWorker(
      queue,
      new BillingSafetyCheckExecutor({ forInstallation: () => api }),
      { write: () => undefined },
    );
    await worker.drain();

    expect(api.createCheckRun).toHaveBeenCalledTimes(1);
    expect(api.completeCheckRun).toHaveBeenCalledTimes(1);
  });

  it("executes one fresh Check Run when the PR is reopened on the same current SHA", async () => {
    const queue = new InMemoryJobQueue();
    const opened = createJob();
    await queue.enqueue(opened);

    const api = createApi();
    const worker = new QueueWorker(
      queue,
      new BillingSafetyCheckExecutor({ forInstallation: () => api }),
      { write: () => undefined },
    );
    await worker.drain();

    const reopened = createJob({
      deliveryId: "00000000-0000-4000-8000-000000000023",
      action: "reopened",
      updatedAt: opened.updatedAt + 1_000,
    });
    expect((await queue.enqueue(reopened)).status).toBe("queued");
    await worker.drain();

    expect(api.createCheckRun).toHaveBeenCalledTimes(2);
    expect(api.completeCheckRun).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createCheckRun).mock.calls.map(([input]) => input.headSha)).toEqual([sha, sha]);
    for (const [input] of vi.mocked(api.completeCheckRun).mock.calls) {
      expect(input.conclusion).toBe("neutral");
      expect(input.summary).toContain("Customer billing tests are not configured or executed.");
    }
  });

  it("keeps GitHub API failures structured and does not log response messages or credentials", async () => {
    const secretLikeValue = "synthetic-installation-token-never-log";
    const rawGitHubError = Object.assign(new Error(`Authorization: ${secretLikeValue}`), {
      status: 503,
      response: { headers: { "x-github-request-id": "safe-request-id" } },
    });
    const queue = new InMemoryJobQueue();
    const job = createJob();
    await queue.enqueue(job);
    const api = createApi({
      getPullRequest: vi.fn().mockRejectedValue(toSafeGitHubApiError("pulls.get", rawGitHubError)),
    });
    const records: unknown[] = [];
    const worker = new QueueWorker(
      queue,
      new BillingSafetyCheckExecutor({ forInstallation: () => api }),
      { write: (record) => records.push(record) },
    );

    await worker.drain();

    const output = JSON.stringify(records);
    expect(output).toContain('"operation":"pulls.get"');
    expect(output).toContain('"httpStatus":503');
    expect(output).toContain('"requestId":"safe-request-id"');
    expect(output).not.toContain(secretLikeValue);
    expect(output).not.toContain("authorization");
    expect(queue.statusFor(job)).toBe("failed");
  });

  it("sanitizes unknown errors to type only", () => {
    const output = JSON.stringify(safeFailureLog(new Error("do not print this token-shaped value")));
    expect(output).toContain('"errorType":"Error"');
    expect(output).not.toContain("token-shaped");
  });
});
