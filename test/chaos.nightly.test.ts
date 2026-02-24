import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";
import { shouldMarkAnimationComplete } from "../src/utils/animation.js";

const templates = [
  { seq: 2, phase: "parsed", status: "in_progress" as const },
  { seq: 3, phase: "normalized", status: "in_progress" as const },
  { seq: 4, phase: "chunked", status: "in_progress" as const },
  { seq: 5, phase: "embedded", status: "in_progress" as const },
  { seq: 6, phase: "indexed", status: "in_progress" as const },
  { seq: 7, phase: "completed", status: "completed" as const }
];

function shuffle<T>(items: T[]): T[] {
  const clone = [...items];
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const tmp = clone[index];
    clone[index] = clone[swapIndex];
    clone[swapIndex] = tmp;
  }
  return clone;
}

describe("chaos guard rails", () => {
  it("eventually converges after duplicates and reordering", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      const container = await buildContainer(() => now);

      await container.store.createProject(`p-${trial}`);
      await container.store.createRun({ run_id: `r-${trial}`, project_id: `p-${trial}`, run_type: "ingestion" });

      await container.emitter.emit({
        run_id: `r-${trial}`,
        project_id: `p-${trial}`,
        phase: "uploaded",
        status: "started",
        seq: 1,
        correlation_id: `trial-${trial}`,
        emitted_at: new Date(now).toISOString()
      });

      const burst = shuffle([...templates, ...templates.slice(0, 3)]);

      for (const event of burst) {
        try {
          await container.emitter.emit({
            run_id: `r-${trial}`,
            project_id: `p-${trial}`,
            phase: event.phase,
            status: event.status,
            seq: event.seq,
            correlation_id: `trial-${trial}`,
            emitted_at: new Date(now).toISOString()
          });
        } catch {
          // Ignore rejected events during chaos injection.
        }

        now += 10;
      }

      const existing = new Set((await container.store.getRunEvents(`p-${trial}`, `r-${trial}`)).map((event) => event.seq));

      for (const event of templates) {
        if (existing.has(event.seq)) {
          continue;
        }

        await container.emitter.emit({
          run_id: `r-${trial}`,
          project_id: `p-${trial}`,
          phase: event.phase,
          status: event.status,
          seq: event.seq,
          correlation_id: `replay-${trial}`,
          emitted_at: new Date(now).toISOString()
        });
        now += 10;
      }

      const trace = await container.store.getRunTrace(`p-${trial}`, `r-${trial}`);
      if (!trace) {
        throw new Error("missing trace");
      }

      expect(trace.gaps.length).toBe(0);
      expect(trace.terminal_count).toBe(1);

      const invalid = trace.transitions.filter((transition) => !transition.valid);
      expect(invalid).toHaveLength(0);

      const events = await container.store.getRunEvents(`p-${trial}`, `r-${trial}`);
      expect(shouldMarkAnimationComplete(events)).toBe(true);
    }
  });
});
