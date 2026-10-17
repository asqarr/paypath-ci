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

    if (this.runStatuses.has(jobKey)) {
      return { status: "duplicate_head", jobKey };
    }

    this.runStatuses.set(jobKey, "queued");
    this.jobs.push(job);
    return { status: "queued", jobKey };
  }

  async claimNext(): Promise<PullRequestJob | undefined> {
    const job = this.jobs.shift();
    if (job) {
      this.runStatuses.set(pullRequestJobKey(job), "running");
    }
    return job;
  }

  async mark(job: PullRequestJob, status: Exclude<JobStatus, "queued" | "running">): Promise<void> {
    this.runStatuses.set(pullRequestJobKey(job), status);
  }

  pendingCount(): number {
    return this.jobs.length;
  }

  statusFor(job: PullRequestJob): JobStatus | undefined {
    return this.runStatuses.get(pullRequestJobKey(job));
  }
}
