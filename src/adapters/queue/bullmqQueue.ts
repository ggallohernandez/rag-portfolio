import { Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { Logger } from "../../services/logger.js";

export type IngestionQueueJobPayload = {
  kind: "ingestion";
  job_id: string;
};

export class BullMQQueueAdapter {
  readonly mode = "external" as const;

  private readonly connection: Redis;
  private readonly queue: Queue<IngestionQueueJobPayload>;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
    private readonly queueName = "ingestion-jobs"
  ) {
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true
    });

    this.queue = new Queue<IngestionQueueJobPayload>(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 5,
        removeOnComplete: true,
        backoff: {
          type: "exponential",
          delay: 500
        }
      }
    });
  }

  async enqueue(_runId: string, payload: Record<string, unknown>): Promise<void> {
    if (payload.kind !== "ingestion" || typeof payload.job_id !== "string") {
      throw new Error("invalid ingestion queue payload");
    }

    await this.queue.add("ingestion", {
      kind: "ingestion",
      job_id: payload.job_id
    });
  }

  createWorker(
    handler: (jobId: string) => Promise<void>,
    onDeadLetter?: (jobId: string, error: Error, attempts: number) => Promise<void> | void
  ): Worker<IngestionQueueJobPayload> {
    const worker = new Worker<IngestionQueueJobPayload>(
      this.queueName,
      async (job: Job<IngestionQueueJobPayload>) => {
        const payload = job.data;
        await handler(payload.job_id);
      },
      {
        connection: this.connection,
        concurrency: 4
      }
    );

    worker.on("failed", (job, error) => {
      this.logger.error("bullmq worker job failed", {
        queue: this.queueName,
        job_id: job?.id,
        error: error.message
      });

      const jobPayload = job?.data;
      if (!job || !jobPayload || jobPayload.kind !== "ingestion") {
        return;
      }

      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= maxAttempts && onDeadLetter) {
        void onDeadLetter(jobPayload.job_id, error, job.attemptsMade);
      }
    });

    return worker;
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
