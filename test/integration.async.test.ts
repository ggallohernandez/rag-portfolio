import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";
import { runWithRetry } from "../src/services/retryPolicy.js";

describe("async guard rails integration", () => {
  it("uses bounded exponential backoff", async () => {
    const calls: number[] = [];
    const waits: number[] = [];

    const result = await runWithRetry(
      async () => {
        calls.push(Date.now());
        if (calls.length < 3) {
          throw new Error("transient");
        }

        return "ok";
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 25
      },
      async (delay) => {
        waits.push(delay);
      }
    );

    expect(result.ok).toBe(true);
    expect(waits).toEqual([10, 20]);
  });

  it("watchdog fails stale runs with synthetic terminal event", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const container = await buildContainer(() => now);

    await container.store.createProject("p1");
    await container.store.createRun({ run_id: "r1", project_id: "p1", run_type: "ingestion" });

    await container.emitter.emit({
      run_id: "r1",
      project_id: "p1",
      phase: "uploaded",
      status: "started",
      correlation_id: "initial",
      emitted_at: new Date(now).toISOString(),
      seq: 1
    });

    await container.store.setHeartbeat("r1", new Date(now - 120_000).toISOString());
    await container.watchdog.scan();

    const state = await container.store.getRunState("p1", "r1");
    expect(state?.status).toBe("failed");
    expect(state?.current_phase).toBe("failed");

    const events = await container.store.getRunEvents("p1", "r1");
    const terminal = events.find((event) => event.phase === "failed");
    expect(terminal?.payload.synthetic).toBe(true);

    const metrics = container.metrics.snapshot();
    expect(metrics.counters.run_timeout_total).toBe(1);
  });

  it("reconciler does not synthesize progress events for fresh runs", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const container = await buildContainer(() => now);

    await container.store.createProject("p1");
    await container.store.createRun({ run_id: "r2", project_id: "p1", run_type: "query" });

    await container.emitter.emit({
      run_id: "r2",
      project_id: "p1",
      phase: "query_received",
      status: "started",
      correlation_id: "initial",
      emitted_at: new Date(now).toISOString(),
      seq: 1
    });

    now += 1_000;
    await container.store.setHeartbeat("r2", new Date(now).toISOString());
    await container.reconciler.reconcile();

    const events = await container.store.getRunEvents("p1", "r2");
    expect(events.length).toBe(1);
    expect(events[0].phase).toBe("query_received");
    expect(events[0].status).toBe("started");
  });
});
