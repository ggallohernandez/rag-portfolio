import {
  assertAllowedTransition,
  hasGap,
  isTerminalEvent
} from "../domain/stateMachine.js";
import {
  EventEnvelope,
  RunPhase,
  RunState,
  RunTrace,
  RunType,
  TraceTransition
} from "../domain/types.js";

export function projectRunState(
  runType: RunType,
  projectId: string,
  runId: string,
  chatId: string | undefined,
  events: EventEnvelope[]
): RunState {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const phase_timings: RunState["phase_timings"] = {};
  const transitions: TraceTransition[] = [];

  let started_at: string | undefined;
  let ended_at: string | undefined;
  let current_phase: RunPhase | undefined;
  let status: RunState["status"] = "pending";
  let last_seq = 0;
  let terminal_event_id: string | undefined;
  let error: string | undefined;

  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    last_seq = Math.max(last_seq, event.seq);

    if (!started_at) {
      started_at = event.emitted_at;
    }

    if (!phase_timings[event.phase]) {
      phase_timings[event.phase] = { started_at: event.emitted_at };
    }

    phase_timings[event.phase].ended_at = event.emitted_at;

    if (index === 0) {
      const firstTransition = assertAllowedTransition(runType, undefined, event.phase);
      transitions.push({
        from_phase: undefined,
        to_phase: event.phase,
        from_seq: undefined,
        to_seq: event.seq,
        valid: firstTransition.valid,
        reason: firstTransition.reason
      });
    } else {
      const previous = sorted[index - 1];
      const contiguous = previous.seq + 1 === event.seq;

      if (contiguous) {
        const transition = assertAllowedTransition(runType, previous.phase, event.phase);
        transitions.push({
          from_phase: previous.phase,
          to_phase: event.phase,
          from_seq: previous.seq,
          to_seq: event.seq,
          valid: transition.valid,
          reason: transition.reason
        });
      } else {
        transitions.push({
          from_phase: previous.phase,
          to_phase: event.phase,
          from_seq: previous.seq,
          to_seq: event.seq,
          valid: false,
          reason: `gap between seq ${previous.seq} and ${event.seq}`
        });
      }
    }

    current_phase = event.phase as RunPhase;
    status = event.status;

    if (isTerminalEvent(runType, event)) {
      ended_at = event.emitted_at;
      terminal_event_id = event.event_id;
      if (event.status === "failed") {
        const message = event.payload.error;
        if (typeof message === "string") {
          error = message;
        }
      }
    }
  }

  const gaps = hasGap(sorted);
  const invalid_transition_count = transitions.filter((transition) => !transition.valid).length;

  return {
    run_id: runId,
    project_id: projectId,
    chat_id: chatId,
    run_type: runType,
    current_phase,
    status,
    last_seq,
    started_at,
    ended_at,
    error,
    phase_timings,
    invalid_transition_count,
    gap_count: gaps.length,
    terminal_event_id
  };
}

export function buildRunTrace(
  runType: RunType,
  projectId: string,
  runId: string,
  events: EventEnvelope[]
): RunTrace {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const transitions: TraceTransition[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];

    if (index === 0) {
      const transition = assertAllowedTransition(runType, undefined, event.phase);
      transitions.push({
        from_phase: undefined,
        to_phase: event.phase,
        from_seq: undefined,
        to_seq: event.seq,
        valid: transition.valid,
        reason: transition.reason
      });
      continue;
    }

    const previous = sorted[index - 1];
    const contiguous = previous.seq + 1 === event.seq;

    if (!contiguous) {
      transitions.push({
        from_phase: previous.phase,
        to_phase: event.phase,
        from_seq: previous.seq,
        to_seq: event.seq,
        valid: false,
        reason: `gap between seq ${previous.seq} and ${event.seq}`
      });
      continue;
    }

    const transition = assertAllowedTransition(runType, previous.phase, event.phase);
    transitions.push({
      from_phase: previous.phase,
      to_phase: event.phase,
      from_seq: previous.seq,
      to_seq: event.seq,
      valid: transition.valid,
      reason: transition.reason
    });
  }

  const terminalCount = sorted.filter((event) => isTerminalEvent(runType, event)).length;

  return {
    run_id: runId,
    project_id: projectId,
    run_type: runType,
    events: sorted,
    transitions,
    gaps: hasGap(sorted),
    has_terminal: terminalCount > 0,
    terminal_count: terminalCount
  };
}
