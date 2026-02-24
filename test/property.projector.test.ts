import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EventEmitterService } from "../src/services/eventEmitter.js";
import { Logger } from "../src/services/logger.js";
import { MetricsRegistry } from "../src/services/metrics.js";
import { RunStore } from "../src/store/runStore.js";

const sequenceToPhase: Record<number, { phase: string; status: "started" | "in_progress" | "completed" }> = {
  1: { phase: "uploaded", status: "started" },
  2: { phase: "parsed", status: "in_progress" },
  3: { phase: "normalized", status: "in_progress" },
  4: { phase: "chunked", status: "in_progress" },
  5: { phase: "embedded", status: "in_progress" },
  6: { phase: "indexed", status: "in_progress" },
  7: { phase: "completed", status: "completed" }
};

describe("projector invariants under duplicates and reordering", () => {
  it("converges to same final state after replay fills gaps", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 2, max: 7 }), { minLength: 0, maxLength: 40 }),
        async (input) => {
          const metrics = new MetricsRegistry();
          const store = new RunStore(metrics);
          const emitter = new EventEmitterService(store, new Logger());

          await store.createProject("p1");
          await store.createRun({ run_id: "r1", project_id: "p1", run_type: "ingestion" });

          await emitter.emit({
            run_id: "r1",
            project_id: "p1",
            phase: sequenceToPhase[1].phase,
            status: sequenceToPhase[1].status,
            seq: 1,
            correlation_id: "test"
          });

          for (const seq of input) {
            const template = sequenceToPhase[seq];
            await emitter.emit({
              run_id: "r1",
              project_id: "p1",
              phase: template.phase,
              status: template.status,
              seq,
              correlation_id: `input-${seq}`
            });
          }

          const beforeReplay = await store.getRunEvents("p1", "r1");
          const uniqueBefore = new Set(beforeReplay.map((event) => event.seq));
          expect(beforeReplay.length).toBe(uniqueBefore.size);

          for (let seq = 2; seq <= 7; seq += 1) {
            if (uniqueBefore.has(seq)) {
              continue;
            }

            const template = sequenceToPhase[seq];
            await emitter.emit({
              run_id: "r1",
              project_id: "p1",
              phase: template.phase,
              status: template.status,
              seq,
              correlation_id: `replay-${seq}`
            });
          }

          const state = await store.getRunState("p1", "r1");
          expect(state?.status).toBe("completed");
          expect(state?.current_phase).toBe("completed");
          expect(state?.last_seq).toBe(7);

          const trace = await store.getRunTrace("p1", "r1");
          expect(trace?.terminal_count).toBe(1);
          expect(trace?.gaps.length).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });
});
