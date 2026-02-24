import { v4 as uuidv4 } from "uuid";
import { DeadLetterJob } from "../domain/types.js";
import { Logger } from "../services/logger.js";
import { RetryPolicyConfig, runWithRetry } from "../services/retryPolicy.js";
import { IRunStore } from "../store/interfaces.js";

export type QueueJob = {
  id: string;
  run_id: string;
  payload: Record<string, unknown>;
};

export class InMemoryQueue {
  private jobs: QueueJob[] = [];

  constructor(
    private readonly store: IRunStore,
    private readonly logger: Logger,
    private readonly retryPolicy: RetryPolicyConfig
  ) {}

  enqueue(runId: string, payload: Record<string, unknown>): QueueJob {
    const job: QueueJob = { id: uuidv4(), run_id: runId, payload };
    this.jobs.push(job);
    return job;
  }

  pendingJobs(): number {
    return this.jobs.length;
  }

  async drain(handler: (job: QueueJob) => Promise<void>): Promise<void> {
    await this.drainWithDeadLetter(handler);
  }

  async drainWithDeadLetter(
    handler: (job: QueueJob) => Promise<void>,
    onDeadLetter?: (job: QueueJob, error: Error, attempts: number) => Promise<void> | void
  ): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) {
        continue;
      }

      const result = await runWithRetry(
        async () => {
          await handler(job);
        },
        this.retryPolicy
      );

      if (!result.ok) {
        const deadLetter: DeadLetterJob = {
          job_id: job.id,
          run_id: job.run_id,
          reason: result.error.message,
          attempts: result.attempts,
          failed_at: new Date().toISOString(),
          payload: job.payload
        };
        await this.store.addDeadLetterJob(deadLetter);
        this.logger.error("job moved to dead letter queue", {
          run_id: job.run_id,
          job_id: job.id,
          attempts: result.attempts,
          error: result.error.message
        });

        if (onDeadLetter) {
          await onDeadLetter(job, result.error, result.attempts);
        }
      }
    }
  }
}
