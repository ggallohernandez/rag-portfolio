import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1;

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const EVENT_STATUSES = [
  "started",
  "in_progress",
  "completed",
  "failed",
  "cancelled"
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const RUN_TYPES = ["ingestion", "query"] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const INGESTION_PHASES = [
  "uploaded",
  "parsed",
  "ocr",
  "normalized",
  "chunked",
  "embedded",
  "indexed",
  "completed",
  "failed",
  "cancelled"
] as const;
export type IngestionPhase = (typeof INGESTION_PHASES)[number];

export const QUERY_PHASES = [
  "query_received",
  "query_embedded",
  "retrieved_vector",
  "retrieved_bm25",
  "reranked",
  "context_built",
  "answer_streaming",
  "answered",
  "failed",
  "cancelled"
] as const;
export type QueryPhase = (typeof QUERY_PHASES)[number];

export type RunPhase = IngestionPhase | QueryPhase;

export const EventEnvelopeSchemaV1 = z.object({
  event_id: z.string().min(1),
  run_id: z.string().min(1),
  project_id: z.string().min(1),
  chat_id: z.string().min(1).optional(),
  phase: z.string().min(1),
  status: z.enum(EVENT_STATUSES),
  seq: z.number().int().positive(),
  emitted_at: z.string().datetime(),
  correlation_id: z.string().min(1),
  causation_id: z.string().min(1).optional(),
  schema_version: z.literal(CURRENT_SCHEMA_VERSION),
  payload: z.record(z.unknown())
});

export const EventEnvelopeSchemaV0 = z.object({
  event_id: z.string().min(1),
  run_id: z.string().min(1),
  project_id: z.string().min(1),
  chat_id: z.string().min(1).optional(),
  phase: z.string().min(1),
  status: z.enum(EVENT_STATUSES),
  seq: z.number().int().positive(),
  emitted_at: z.string().datetime(),
  correlation_id: z.string().min(1),
  schema_version: z.literal(0),
  payload: z.record(z.unknown())
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchemaV1>;

export type PhaseTiming = {
  started_at: string;
  ended_at?: string;
};

export type RunState = {
  run_id: string;
  project_id: string;
  chat_id?: string;
  run_type: RunType;
  current_phase?: RunPhase;
  status: EventStatus | "pending";
  last_seq: number;
  started_at?: string;
  ended_at?: string;
  error?: string;
  phase_timings: Record<string, PhaseTiming>;
  invalid_transition_count: number;
  gap_count: number;
  terminal_event_id?: string;
};

export type TransitionResult = {
  valid: boolean;
  reason?: string;
};

export type TraceTransition = {
  from_phase?: string;
  to_phase: string;
  from_seq?: number;
  to_seq: number;
  valid: boolean;
  reason?: string;
};

export type RunTrace = {
  run_id: string;
  project_id: string;
  run_type: RunType;
  events: EventEnvelope[];
  transitions: TraceTransition[];
  gaps: Array<{ expected_seq: number; actual_seq: number }>;
  has_terminal: boolean;
  terminal_count: number;
};

export type DeadLetterJob = {
  job_id: string;
  run_id: string;
  reason: string;
  attempts: number;
  failed_at: string;
  payload: Record<string, unknown>;
};
