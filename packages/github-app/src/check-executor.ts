import { BILLING_CHECK_NOTICE, CHECK_RUN_NAME } from "./model.js";
import type { GitHubApiFactory, PullRequestJob } from "./model.js";

export type CheckExecutionResult = "completed" | "stale";

export class BillingSafetyCheckExecutor {
  constructor(
    private readonly apiFactory: GitHubApiFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(job: PullRequestJob): Promise<CheckExecutionResult> {
    const api = this.apiFactory.forInstallation({
      installationId: job.installationId,
      repositoryId: job.repositoryId,
    });
    const pullRequest = await api.getPullRequest({
      owner: job.owner,
      repositoryName: job.repositoryName,
      pullRequestNumber: job.pullRequestNumber,
    });

    // A delayed webhook must not create a run for an obsolete SHA.
    if (pullRequest.headSha !== job.headSha || pullRequest.baseRepositoryId !== job.repositoryId) {
      return "stale";
    }

    const startedAt = this.now().toISOString();
    const checkRun = await api.createCheckRun({
      status: "in_progress",
      owner: job.owner,
      repositoryName: job.repositoryName,
      name: CHECK_RUN_NAME,
      headSha: job.headSha,
      externalId: `paypath:${job.repositoryId}:${job.pullRequestNumber}:${job.headSha}`,
      startedAt,
    });

    const forkNotice = job.isFork
      ? "This pull request comes from a fork. PayPath does not check out or execute untrusted pull request code.\n\n"
      : "";
    await api.completeCheckRun({
      status: "completed",
      owner: job.owner,
      repositoryName: job.repositoryName,
      checkRunId: checkRun.id,
      conclusion: job.isFork ? "action_required" : "neutral",
      completedAt: this.now().toISOString(),
      title: job.isFork ? "Untrusted fork requires maintainer review" : "Billing tests are not configured",
      summary: `${forkNotice}${BILLING_CHECK_NOTICE}`,
    });

    return "completed";
  }
}
