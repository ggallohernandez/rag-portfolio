import {
  assertNoEventAfterTerminal,
  contiguousTransitionsAreValid,
  hasDuplicateSequence,
  hasSingleTerminalEvent
} from "../domain/stateMachine.js";
import { DeadLetterJob, EventEnvelope, RunState } from "../domain/types.js";
import { MetricsRegistry } from "../services/metrics.js";
import { buildRunTrace, projectRunState } from "../services/runProjector.js";
import { AppendResult, IRunStore, RunEventSubscriber, RunRecord } from "./interfaces.js";

export class RunStore implements IRunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runEvents = new Map<string, EventEnvelope[]>();
  private readonly runStates = new Map<string, RunState>();
  private readonly runHeartbeats = new Map<string, string>();
  private readonly deadLetterJobs: DeadLetterJob[] = [];
  private readonly subscribers = new Map<string, Set<RunEventSubscriber>>();
  private readonly projects = new Set<string>();
  private readonly eventIds = new Set<string>();

  constructor(private readonly metrics: MetricsRegistry) {}

  async createProject(projectId: string): Promise<void> {
    this.projects.add(projectId);
  }

  async hasProject(projectId: string): Promise<boolean> {
    return this.projects.has(projectId);
  }

  async createRun(record: RunRecord): Promise<RunState> {
    if (!this.projects.has(record.project_id)) {
      this.projects.add(record.project_id);
    }

    this.runs.set(record.run_id, record);
    this.runEvents.set(record.run_id, []);

    const initial: RunState = {
      run_id: record.run_id,
      project_id: record.project_id,
      chat_id: record.chat_id,
      run_type: record.run_type,
      status: "pending",
      last_seq: 0,
      phase_timings: {},
      invalid_transition_count: 0,
      gap_count: 0
    };

    this.runStates.set(record.run_id, initial);
    this.runHeartbeats.set(record.run_id, new Date().toISOString());
    return initial;
  }

  async getRunRecord(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async getRunState(projectId: string, runId: string): Promise<RunState | undefined> {
    const run = this.runs.get(runId);
    if (!run || run.project_id !== projectId) {
      return undefined;
    }

    return this.runStates.get(runId);
  }

  async getRunEvents(projectId: string, runId: string): Promise<EventEnvelope[]> {
    const run = this.runs.get(runId);
    if (!run || run.project_id !== projectId) {
      return [];
    }

    return [...(this.runEvents.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async getEventById(runId: string, eventId: string): Promise<EventEnvelope | undefined> {
    const events = this.runEvents.get(runId) ?? [];
    return events.find((event) => event.event_id === eventId);
  }

  async appendEvent(event: EventEnvelope): Promise<AppendResult> {
    const run = this.runs.get(event.run_id);
    if (!run) {
      throw new Error(`run '${event.run_id}' does not exist`);
    }

    if (run.project_id !== event.project_id) {
      throw new Error("project mismatch for run event");
    }

    const existing = this.runEvents.get(event.run_id) ?? [];

    if (this.eventIds.has(event.event_id)) {
      this.metrics.increment("duplicate_events_total");
      return { inserted: false, duplicate: true, out_of_order: false };
    }

    const duplicateSeq = existing.some((candidate) => candidate.seq === event.seq);
    if (duplicateSeq) {
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

    this.runEvents.set(event.run_id, candidateEvents);
    this.eventIds.add(event.event_id);
    this.runHeartbeats.set(event.run_id, new Date().toISOString());

    const projected = projectRunState(
      run.run_type,
      run.project_id,
      run.run_id,
      run.chat_id,
      candidateEvents
    );

    this.runStates.set(event.run_id, projected);

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
    return [...this.runStates.values()].filter(
      (state) => state.status !== "completed" && state.status !== "failed" && state.status !== "cancelled"
    );
  }

  async getHeartbeat(runId: string): Promise<string | undefined> {
    return this.runHeartbeats.get(runId);
  }

  async setHeartbeat(runId: string, value: string): Promise<void> {
    this.runHeartbeats.set(runId, value);
  }

  async getRunTrace(projectId: string, runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.project_id !== projectId) {
      return undefined;
    }

    const events = await this.getRunEvents(projectId, runId);
    return buildRunTrace(run.run_type, run.project_id, run.run_id, events);
  }

  async addDeadLetterJob(job: DeadLetterJob): Promise<void> {
    this.deadLetterJobs.push(job);
  }

  async listDeadLetterJobs(): Promise<DeadLetterJob[]> {
    return [...this.deadLetterJobs];
  }
}
