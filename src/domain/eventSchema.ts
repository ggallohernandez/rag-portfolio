import {
  CURRENT_SCHEMA_VERSION,
  EventEnvelope,
  EventEnvelopeSchemaV0,
  EventEnvelopeSchemaV1
} from "./types.js";

export function normalizeEventEnvelope(raw: unknown): EventEnvelope {
  const v1Result = EventEnvelopeSchemaV1.safeParse(raw);
  if (v1Result.success) {
    return v1Result.data;
  }

  const v0Result = EventEnvelopeSchemaV0.safeParse(raw);
  if (v0Result.success) {
    return {
      ...v0Result.data,
      schema_version: CURRENT_SCHEMA_VERSION,
      causation_id: undefined
    };
  }

  throw new Error(`invalid event envelope: ${v1Result.error.message}`);
}

export function validateCurrentSchema(event: EventEnvelope): void {
  if (event.schema_version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported schema version '${event.schema_version}', expected '${CURRENT_SCHEMA_VERSION}'`
    );
  }
}
