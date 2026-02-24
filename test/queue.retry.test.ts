import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";
import { InMemoryQueue } from "../src/queue/inMemoryQueue.js";

describe("queue reliability guard rails", () => {
  it("retries failed jobs and preserves idempotent event state", async () => {
    const container = await buildContainer();
    const queue = container.queue as InMemoryQueue;

    await container.store.createProject("p1");
    await container.store.createRun({ run_id: "r1", project_id: "p1", run_type: "ingestion" });

    let crashes = 0;

    const job = queue.enqueue("r1", {
      event: {
        run_id: "r1",
        project_id: "p1",
        phase: "uploaded",
        status: "started",
        seq: 1,
        correlation_id: "queue"
      }
    });

    await queue.drain(async (queuedJob) => {
      expect(queuedJob.id).toBe(job.id);
      crashes += 1;
      if (crashes === 1) {
        throw new Error("worker crashed before commit");
      }

      const payload = queuedJob.payload.event as Record<string, unknown>;
      await container.emitter.emit({
        run_id: payload.run_id as string,
        project_id: payload.project_id as string,
        phase: payload.phase as string,
        status: payload.status as "started",
        seq: payload.seq as number,
        correlation_id: payload.correlation_id as string
      });

      // Simulate at-least-once duplicate delivery.
      await container.emitter.emit({
        run_id: payload.run_id as string,
        project_id: payload.project_id as string,
        phase: payload.phase as string,
        status: payload.status as "started",
        seq: payload.seq as number,
        correlation_id: payload.correlation_id as string
      });
    });

    const events = await container.store.getRunEvents("p1", "r1");
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
    expect(await container.store.listDeadLetterJobs()).toHaveLength(0);
  });

  it("moves permanently failing jobs to DLQ", async () => {
    const container = await buildContainer();
    const queue = container.queue as InMemoryQueue;

    await container.store.createProject("p1");
    await container.store.createRun({ run_id: "r2", project_id: "p1", run_type: "query" });

    queue.enqueue("r2", { type: "always_fail" });

    await queue.drain(async () => {
      throw new Error("non-recoverable");
    });

    const jobs = await container.store.listDeadLetterJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].run_id).toBe("r2");
    expect(jobs[0].attempts).toBe(3);
  });
});
