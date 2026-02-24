import { randomUUID } from "node:crypto";
import {
  assertNoEventAfterTerminal,
  contiguousTransitionsAreValid,
  hasDuplicateSequence,
  hasSingleTerminalEvent
} from "../../domain/stateMachine.js";
import { CURRENT_SCHEMA_VERSION, DeadLetterJob, EventEnvelope, RunState, RunTrace } from "../../domain/types.js";
import { MetricsRegistry } from "../../services/metrics.js";
import { buildRunTrace, projectRunState } from "../../services/runProjector.js";
import { AppendResult, IRunStore, RunEventSubscriber, RunRecord } from "../../store/interfaces.js";
import { PostgresClient } from "./postgresClient.js";

export class PostgresRunStore implements IRunStore {
  private readonly subscribers = new Map<string, Set<RunEventSubscriber>>();

  constructor(
    private readonly db: PostgresClient,
    private readonly metrics: MetricsRegistry
  ) {}

  async createProject(projectId: string): Promise<void> {
    await this.db.query(
      `insert into run_projects (id)
       values ($1)
       on conflict (id) do nothing`,
      [projectId]
    );
  }

  async hasProject(projectId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `select exists(select 1 from run_projects where id = $1) as exists`,
      [projectId]
    );

    return Boolean(result.rows[0]?.exists);
  }

  async createRun(record: RunRecord): Promise<RunState> {
    await this.db.withTransaction(async (client) => {
      await client.query(
        `insert into run_projects (id)
         values ($1)
         on conflict (id) do nothing`,
        [record.project_id]
      );

      await client.query(
        `insert into runs (run_id, project_id, run_type, chat_id)
         values ($1,$2,$3,$4)
         on conflict (run_id) do update set project_id = excluded.project_id`,
        [record.run_id, record.project_id, record.run_type, record.chat_id ?? null]
      );

      await client.query(
        `insert into run_state
          (run_id, current_phase, status, last_seq, started_at, ended_at, error, phase_timings, invalid_transition_count, gap_count, terminal_event_id)
         values
          ($1, null, 'pending', 0, null, null, null, '{}'::jsonb, 0, 0, null)
         on conflict (run_id) do nothing`,
        [record.run_id]
      );

      await client.query(
        `insert into run_heartbeats (run_id, heartbeat_at)
         values ($1, now())
         on conflict (run_id) do update set heartbeat_at = excluded.heartbeat_at`,
        [record.run_id]
      );
    });

    const state = await this.getRunState(record.project_id, record.run_id);
    if (!state) {
      throw new Error(`failed to create run '${record.run_id}'`);
    }

    return state;
  }

  async getRunRecord(runId: string): Promise<RunRecord | undefined> {
    const result = await this.db.query<Omit<RunRecord, "chat_id"> & { chat_id: string | null }>(
      `select run_id, project_id, run_type, chat_id
       from runs
       where run_id = $1
       limit 1`,
      [runId]
    );

    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    return {
      ...row,
      chat_id: toOptionalString(row.chat_id)
    };
  }

  async getRunState(projectId: string, runId: string): Promise<RunState | undefined> {
    const result = await this.db.query<
      Omit<RunState, "chat_id" | "phase_timings"> & {
        chat_id: string | null;
        phase_timings: string | Record<string, unknown>;
      }
    >(
      `select s.run_id, r.project_id, r.chat_id, r.run_type,
              s.current_phase, s.status, s.last_seq,
              s.started_at::text as started_at,
              s.ended_at::text as ended_at,
              s.error,
              s.phase_timings,
              s.invalid_transition_count,
              s.gap_count,
              s.terminal_event_id
       from run_state s
       join runs r on r.run_id = s.run_id
       where s.run_id = $1 and r.project_id = $2
       limit 1`,
      [runId, projectId]
    );

    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    return {
      ...row,
      chat_id: toOptionalString(row.chat_id),
      phase_timings: normalizeJson(row.phase_timings) as RunState["phase_timings"]
    };
  }

  async getRunEvents(projectId: string, runId: string): Promise<EventEnvelope[]> {
    const run = await this.getRunRecord(runId);
    if (!run || run.project_id !== projectId) {
      return [];
    }

    const result = await this.db.query<
      Omit<EventEnvelope, "chat_id" | "causation_id" | "payload"> & {
        chat_id: string | null;
        causation_id: string | null;
        schema_version: string | number;
        payload: string | Record<string, unknown>;
      }
    >(
      `select event_id, run_id, project_id, chat_id, phase, status, seq,
              emitted_at::text,
              correlation_id,
              causation_id,
              schema_version,
              payload_json as payload
       from run_events
       where run_id = $1
       order by seq asc`,
      [runId]
    );

    return result.rows.map((row) => normalizeEvent(row));
  }

  async getEventById(runId: string, eventId: string): Promise<EventEnvelope | undefined> {
    const result = await this.db.query<
      Omit<EventEnvelope, "chat_id" | "causation_id" | "payload"> & {
        chat_id: string | null;
        causation_id: string | null;
        schema_version: string | number;
        payload: string | Record<string, unknown>;
      }
    >(
      `select event_id, run_id, project_id, chat_id, phase, status, seq,
              emitted_at::text,
              correlation_id,
              causation_id,
              schema_version,
              payload_json as payload
       from run_events
       where run_id = $1 and event_id = $2
       limit 1`,
      [runId, eventId]
    );

    const row = result.rows[0];
    return row ? normalizeEvent(row) : undefined;
  }

  async appendEvent(event: EventEnvelope): Promise<AppendResult> {
    const run = await this.getRunRecord(event.run_id);
    if (!run) {
      throw new Error(`run '${event.run_id}' does not exist`);
    }

    if (run.project_id !== event.project_id) {
      throw new Error("project mismatch for run event");
    }

    const existing = await this.getRunEvents(event.project_id, event.run_id);

    if (existing.some((candidate) => candidate.event_id === event.event_id)) {
      this.metrics.increment("duplicate_events_total");
      return { inserted: false, duplicate: true, out_of_order: false };
    }

    if (existing.some((candidate) => candidate.seq === event.seq)) {
      this.metrics.increment("duplicate_events_total");
      return { inserted: false, duplicate: true, out_of_order: false };
    }

    const candidateEvents = [...existing, event].sort((a, b) => a.seq - b.seq);

    const duplicateCheck = hasDuplicateSequence(candidateEvents);
    if (!duplicateCheck.valid) {
      throw new Error(duplicateCheck.reason);
    }

    const terminalCheck = hasSingleTerminalEvent(run.run_type, candidateEvents);
    if (!terminalCheck.valid) {
      throw new Error(terminalCheck.reason);
    }

    const afterTerminalCheck = assertNoEventAfterTerminal(run.run_type, candidateEvents);
    if (!afterTerminalCheck.valid) {
      throw new Error(afterTerminalCheck.reason);
    }

    const transitionCheck = contiguousTransitionsAreValid(run.run_type, candidateEvents);
    if (!transitionCheck.valid) {
      throw new Error(transitionCheck.reason);
    }

    const previousMaxSeq = existing.reduce((max, candidate) => Math.max(max, candidate.seq), 0);
    const outOfOrder = event.seq <= previousMaxSeq;
    if (outOfOrder) {
      this.metrics.increment("out_of_order_events_total");
    }

    const emittedAtMs = new Date(event.emitted_at).getTime();
    const nowMs = Date.now();
    if (!Number.isNaN(emittedAtMs)) {
      this.metrics.observe("event_lag_ms", Math.max(0, nowMs - emittedAtMs));
    }

    await this.db.withTransaction(async (client) => {
      await client.query(
        `insert into run_events
          (event_id, run_id, project_id, chat_id, phase, status, seq, emitted_at, correlation_id, causation_id, schema_version, payload_json)
         values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          event.event_id,
          event.run_id,
          event.project_id,
          event.chat_id ?? null,
          event.phase,
          event.status,
          event.seq,
          event.emitted_at,
          event.correlation_id,
          event.causation_id ?? null,
          event.schema_version,
          JSON.stringify(event.payload)
        ]
      );

      const projected = projectRunState(run.run_type, run.project_id, run.run_id, run.chat_id, candidateEvents);

      await client.query(
        `update run_state
         set current_phase = $2,
             status = $3,
             last_seq = $4,
             started_at = $5,
             ended_at = $6,
             error = $7,
             phase_timings = $8::jsonb,
             invalid_transition_count = $9,
             gap_count = $10,
             terminal_event_id = $11
         where run_id = $1`,
        [
          run.run_id,
          projected.current_phase ?? null,
          projected.status,
          projected.last_seq,
          projected.started_at ?? null,
          projected.ended_at ?? null,
          projected.error ?? null,
          JSON.stringify(projected.phase_timings),
          projected.invalid_transition_count,
          projected.gap_count,
          projected.terminal_event_id ?? null
        ]
      );

      await client.query(
        `insert into run_heartbeats (run_id, heartbeat_at)
         values ($1, now())
         on conflict (run_id) do update set heartbeat_at = excluded.heartbeat_at`,
        [run.run_id]
      );
    });

    const runSubscribers = this.subscribers.get(event.run_id);
    if (runSubscribers) {
      for (const subscriber of runSubscribers) {
        subscriber(event);
      }
    }

    return { inserted: true, duplicate: false, out_of_order: outOfOrder };
  }

  subscribeToRunEvents(runId: string, handler: RunEventSubscriber): () => void {
    const runSubscribers = this.subscribers.get(runId) ?? new Set<RunEventSubscriber>();
    runSubscribers.add(handler);
    this.subscribers.set(runId, runSubscribers);

    return () => {
      const subscribers = this.subscribers.get(runId);
      if (!subscribers) {
        return;
      }

      subscribers.delete(handler);
      if (subscribers.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  async listNonTerminalRuns(): Promise<RunState[]> {
    const result = await this.db.query<
      Omit<RunState, "chat_id" | "phase_timings"> & {
        chat_id: string | null;
        phase_timings: string | Record<string, unknown>;
      }
    >(
      `select s.run_id, r.project_id, r.chat_id, r.run_type,
              s.current_phase, s.status, s.last_seq,
              s.started_at::text as started_at,
              s.ended_at::text as ended_at,
              s.error,
              s.phase_timings,
              s.invalid_transition_count,
              s.gap_count,
              s.terminal_event_id
       from run_state s
       join runs r on r.run_id = s.run_id
       where s.status not in ('completed', 'failed', 'cancelled')`
    );

    return result.rows.map((row) => ({
      ...row,
      chat_id: toOptionalString(row.chat_id),
      phase_timings: normalizeJson(row.phase_timings) as RunState["phase_timings"]
    }));
  }

  async getHeartbeat(runId: string): Promise<string | undefined> {
    const result = await this.db.query<{ heartbeat_at: string }>(
      `select heartbeat_at::text
       from run_heartbeats
       where run_id = $1
       limit 1`,
      [runId]
    );

    return result.rows[0]?.heartbeat_at;
  }

  async setHeartbeat(runId: string, value: string): Promise<void> {
    await this.db.query(
      `insert into run_heartbeats (run_id, heartbeat_at)
       values ($1, $2)
       on conflict (run_id) do update set heartbeat_at = excluded.heartbeat_at`,
      [runId, value]
    );
  }

  async getRunTrace(projectId: string, runId: string): Promise<RunTrace | undefined> {
    const run = await this.getRunRecord(runId);
    if (!run || run.project_id !== projectId) {
      return undefined;
    }

    const events = await this.getRunEvents(projectId, runId);
    return buildRunTrace(run.run_type, run.project_id, run.run_id, events);
  }

  async addDeadLetterJob(job: DeadLetterJob): Promise<void> {
    await this.db.query(
      `insert into dead_letter_jobs (job_id, run_id, reason, attempts, failed_at, payload_json)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (job_id) do update set reason = excluded.reason, attempts = excluded.attempts`,
      [job.job_id, job.run_id, job.reason, job.attempts, job.failed_at, JSON.stringify(job.payload)]
    );
  }

  async listDeadLetterJobs(): Promise<DeadLetterJob[]> {
    const result = await this.db.query<
      Omit<DeadLetterJob, "payload"> & { payload_json: string | Record<string, unknown> }
    >(
      `select job_id, run_id, reason, attempts, failed_at::text, payload_json
       from dead_letter_jobs
       order by failed_at desc`
    );

    return result.rows.map((row) => ({
      job_id: row.job_id,
      run_id: row.run_id,
      reason: row.reason,
      attempts: row.attempts,
      failed_at: row.failed_at,
      payload: normalizeJson(row.payload_json)
    }));
  }
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }

  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeEvent(
  row: Omit<EventEnvelope, "chat_id" | "causation_id" | "payload"> & {
    chat_id: string | null;
    causation_id: string | null;
    schema_version: string | number;
    payload: string | Record<string, unknown>;
  }
): EventEnvelope {
  return {
    ...row,
    chat_id: toOptionalString(row.chat_id),
    causation_id: toOptionalString(row.causation_id),
    schema_version: CURRENT_SCHEMA_VERSION,
    payload: normalizeJson(row.payload)
  };
}

function toOptionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}
