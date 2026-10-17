import { safeFailureLog } from "./errors.js";
import type { JobQueue, SafeLogger } from "./model.js";
import type { BillingSafetyCheckExecutor } from "./check-executor.js";

/** Single-process queue worker. Replace with a durable worker for production. */
export class QueueWorker {
  private draining: Promise<void> | undefined;

  constructor(
    private readonly queue: JobQueue,
    private readonly executor: BillingSafetyCheckExecutor,
    private readonly logger: SafeLogger,
  ) {}

  async drain(): Promise<void> {
    if (this.draining) {
      return this.draining;
    }

    this.draining = this.runLoop().finally(() => {
      this.draining = undefined;
      // An enqueue can race with the final empty read. Pick up anything that
      // arrived while the current drain was completing.
      if (this.queue.pendingCount() > 0) {
        void this.drain();
      }
    });
    try {
      await this.draining;
    } catch {
      // The worker reports per-job failures with safe metadata in runLoop.
    }
  }

  private async runLoop(): Promise<void> {
    let job = await this.queue.claimNext();
    while (job) {
      try {
        const result = await this.executor.execute(job);
        await this.queue.mark(job, result === "stale" ? "stale" : "completed");
        this.logger.write({
          level: "info",
          event: result === "stale" ? "github_app_job_skipped_stale_sha" : "github_app_job_completed",
          operation: "create-check-run",
        });
      } catch (error) {
        try {
          await this.queue.mark(job, "failed");
        } catch {
          // A production queue adapter should alert through its own safe channel.
        }
        try {
          this.logger.write(safeFailureLog(error));
        } catch {
          // Logging failure must not expose or transform the original error.
        }
      }
      job = await this.queue.claimNext();
    }
  }
}
