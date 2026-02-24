import { describe, expect, it } from "vitest";
import { normalizeEventEnvelope, validateCurrentSchema } from "../src/domain/eventSchema.js";

const iso = new Date("2026-01-01T00:00:00.000Z").toISOString();

describe("event envelope contract", () => {
  it("accepts v1 envelope", () => {
    const event = normalizeEventEnvelope({
      event_id: "evt-1",
      run_id: "run-1",
      project_id: "project-1",
      phase: "uploaded",
      status: "started",
      seq: 1,
      emitted_at: iso,
      correlation_id: "corr-1",
      schema_version: 1,
      payload: { foo: "bar" }
    });

    validateCurrentSchema(event);
    expect(event.schema_version).toBe(1);
    expect(event.phase).toBe("uploaded");
  });

  it("upgrades supported v0 envelope to current schema", () => {
    const event = normalizeEventEnvelope({
      event_id: "evt-1",
      run_id: "run-1",
      project_id: "project-1",
      phase: "uploaded",
      status: "started",
      seq: 1,
      emitted_at: iso,
      correlation_id: "corr-1",
      schema_version: 0,
      payload: {}
    });

    expect(event.schema_version).toBe(1);
    expect(event.causation_id).toBeUndefined();
  });

  it("rejects invalid schema", () => {
    expect(() =>
      normalizeEventEnvelope({
        event_id: "evt-1",
        run_id: "run-1",
        project_id: "project-1",
        phase: "uploaded",
        status: "started",
        seq: -1,
        emitted_at: iso,
        correlation_id: "corr-1",
        schema_version: 2,
        payload: {}
      })
    ).toThrowError(/invalid event envelope/);
  });
});
