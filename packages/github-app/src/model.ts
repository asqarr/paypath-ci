export const CHECK_RUN_NAME = "PayPath CI / Billing Safety";
export const BILLING_CHECK_NOTICE =
  "GitHub integration verified. Customer billing tests are not configured or executed.";

export const SUPPORTED_PULL_REQUEST_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
] as const;

export type PullRequestAction = (typeof SUPPORTED_PULL_REQUEST_ACTIONS)[number];

export interface PullRequestJob {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  owner: string;
  repositoryName: string;
  pullRequestNumber: number;
  headSha: string;
  action: PullRequestAction;
  updatedAt: number;
  isFork: boolean;
}

export type EnqueueResult =
  | { status: "queued"; jobKey: string }
  | { status: "duplicate_delivery"; jobKey: string }
  | { status: "duplicate_head"; jobKey: string }
  | { status: "stale_event"; jobKey: string };

export type JobStatus = "queued" | "running" | "completed" | "stale" | "failed";

export interface JobQueue {
  enqueue(job: PullRequestJob): Promise<EnqueueResult>;
  claimNext(): Promise<PullRequestJob | undefined>;
  mark(job: PullRequestJob, status: Exclude<JobStatus, "queued" | "running">): Promise<void>;
  pendingCount(): number;
}

export interface CurrentPullRequest {
  headSha: string;
  baseRepositoryId: number;
}

export interface CreateCheckRunInput {
  status: "in_progress";
  owner: string;
  repositoryName: string;
  name: string;
  headSha: string;
  externalId: string;
  startedAt: string;
}

export type CheckConclusion = "neutral" | "action_required";

export interface CompleteCheckRunInput {
  status: "completed";
  owner: string;
  repositoryName: string;
  checkRunId: number;
  conclusion: CheckConclusion;
  completedAt: string;
  title: string;
  summary: string;
}

export interface GitHubRepositoryApi {
  getPullRequest(input: {
    owner: string;
    repositoryName: string;
    pullRequestNumber: number;
  }): Promise<CurrentPullRequest>;
  createCheckRun(input: CreateCheckRunInput): Promise<{ id: number }>;
  completeCheckRun(input: CompleteCheckRunInput): Promise<void>;
}

export interface GitHubApiFactory {
  forInstallation(input: {
    installationId: number;
    repositoryId: number;
  }): GitHubRepositoryApi;
}

export interface SafeLogRecord {
  level: "info" | "warn" | "error";
  event: string;
  operation?: string;
  errorType?: string;
  errorCode?: string;
  httpStatus?: number;
  requestId?: string;
}

export interface SafeLogger {
  write(record: SafeLogRecord): void;
}

export function pullRequestJobKey(job: PullRequestJob): string {
  return `${job.repositoryId}:${job.pullRequestNumber}:${job.headSha}`;
}

export function pullRequestIdentity(job: PullRequestJob): string {
  return `${job.repositoryId}:${job.pullRequestNumber}`;
}
