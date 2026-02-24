import { describe, expect, it } from "vitest";
import {
  assertAllowedTransition,
  assertNoEventAfterTerminal,
  hasSingleTerminalEvent,
  isTerminalEvent
} from "../src/domain/stateMachine.js";
import { EventEnvelope } from "../src/domain/types.js";

function createEvent(
  phase: string,
  status: EventEnvelope["status"],
  seq: number
): EventEnvelope {
  return {
    event_id: `event-${seq}`,
    run_id: "run-1",
    project_id: "project-1",
    phase,
    status,
    seq,
    emitted_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    correlation_id: "corr-1",
    schema_version: 1,
    payload: {}
  };
}

describe("state machine transitions", () => {
  it("accepts valid ingestion transitions", () => {
    expect(assertAllowedTransition("ingestion", undefined, "uploaded").valid).toBe(true);
    expect(assertAllowedTransition("ingestion", "uploaded", "parsed").valid).toBe(true);
    expect(assertAllowedTransition("ingestion", "parsed", "normalized").valid).toBe(true);
    expect(assertAllowedTransition("ingestion", "indexed", "completed").valid).toBe(true);
  });

  it("rejects invalid ingestion transitions", () => {
    const result = assertAllowedTransition("ingestion", "uploaded", "embedded");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  it("accepts valid query transitions", () => {
    expect(assertAllowedTransition("query", undefined, "query_received").valid).toBe(true);
    expect(assertAllowedTransition("query", "query_received", "query_embedded").valid).toBe(true);
    expect(assertAllowedTransition("query", "answer_streaming", "answered").valid).toBe(true);
  });

  it("rejects invalid query transitions", () => {
    const result = assertAllowedTransition("query", "query_received", "reranked");
    expect(result.valid).toBe(false);
  });

  it("enforces single terminal event per run", () => {
    const events = [
      createEvent("uploaded", "started", 1),
      createEvent("completed", "completed", 2),
      createEvent("failed", "failed", 3)
    ];

    const result = hasSingleTerminalEvent("ingestion", events);
    expect(result.valid).toBe(false);
  });

  it("rejects events after terminal", () => {
    const events = [
      createEvent("uploaded", "started", 1),
      createEvent("completed", "completed", 2),
      createEvent("indexed", "in_progress", 3)
    ];

    const result = assertNoEventAfterTerminal("ingestion", events);
    expect(result.valid).toBe(false);
  });

  it("marks query answered as terminal when completed", () => {
    const event = createEvent("answered", "completed", 8);
    expect(isTerminalEvent("query", event)).toBe(true);
  });
});
