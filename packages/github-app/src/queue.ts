import type {
  EnqueueResult,
  JobQueue,
  JobStatus,
  PullRequestJob,
} from "./model.js";
import { pullRequestIdentity, pullRequestJobKey } from "./model.js";

/**
 * Development-only queue. Production deployments must replace this adapter with
 * a durable queue/store that survives restarts and supports retry visibility.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly deliveries = new Set<string>();
  private readonly runStatuses = new Map<string, JobStatus>();
  private readonly jobs: PullRequestJob[] = [];
  private readonly latestEvents = new Map<string, number>();

  private executionKey(job: PullRequestJob): string {
    const jobKey = pullRequestJobKey(job);

    // A reopened action starts a new valid PR lifecycle even when the head SHA
    // is unchanged. Its update timestamp is shared by redeliveries of that
    // lifecycle, so concurrent deliveries still collapse to one run.
    return job.action === "reopened"
      ? `${jobKey}:reopened:${job.updatedAt}`
      : jobKey;
  }

  async enqueue(job: PullRequestJob): Promise<EnqueueResult> {
    const jobKey = pullRequestJobKey(job);
    if (this.deliveries.has(job.deliveryId)) {
      return { status: "duplicate_delivery", jobKey };
    }
    this.deliveries.add(job.deliveryId);

    const identity = pullRequestIdentity(job);
    const latest = this.latestEvents.get(identity);
    if (latest !== undefined && job.updatedAt < latest) {
      return { status: "stale_event", jobKey };
    }

    if (latest === undefined || job.updatedAt >= latest) {
      this.latestEvents.set(identity, job.updatedAt);
    }

    const executionKey = this.executionKey(job);
    if (this.runStatuses.has(executionKey)) {
      return { status: "duplicate_head", jobKey };
    }

    this.runStatuses.set(executionKey, "queued");
    this.jobs.push(job);
    return { status: "queued", jobKey };
  }

  async claimNext(): Promise<PullRequestJob | undefined> {
    const job = this.jobs.shift();
    if (job) {
      this.runStatuses.set(this.executionKey(job), "running");
    }
    return job;
  }

  async mark(job: PullRequestJob, status: Exclude<JobStatus, "queued" | "running">): Promise<void> {
    this.runStatuses.set(this.executionKey(job), status);
  }

  pendingCount(): number {
    return this.jobs.length;
  }

  statusFor(job: PullRequestJob): JobStatus | undefined {
    return this.runStatuses.get(this.executionKey(job));
  }
}
