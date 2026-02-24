import {
  EventEnvelope,
  IngestionPhase,
  QueryPhase,
  RunType,
  TransitionResult
} from "./types.js";

const ingestionTransitions: Record<string, Set<string>> = {
  uploaded: new Set(["parsed", "failed", "cancelled"]),
  parsed: new Set(["ocr", "normalized", "failed", "cancelled"]),
  ocr: new Set(["normalized", "failed", "cancelled"]),
  normalized: new Set(["chunked", "failed", "cancelled"]),
  chunked: new Set(["embedded", "failed", "cancelled"]),
  embedded: new Set(["indexed", "failed", "cancelled"]),
  indexed: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

const queryTransitions: Record<string, Set<string>> = {
  query_received: new Set(["query_embedded", "failed", "cancelled"]),
  query_embedded: new Set(["retrieved_vector", "retrieved_bm25", "failed", "cancelled"]),
  retrieved_vector: new Set(["retrieved_bm25", "reranked", "failed", "cancelled"]),
  retrieved_bm25: new Set(["reranked", "failed", "cancelled"]),
  reranked: new Set(["context_built", "failed", "cancelled"]),
  context_built: new Set(["answer_streaming", "failed", "cancelled"]),
  answer_streaming: new Set(["answered", "failed", "cancelled"]),
  answered: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

const runStartPhase: Record<RunType, string> = {
  ingestion: "uploaded",
  query: "query_received"
};

export function isTerminalEvent(runType: RunType, event: EventEnvelope): boolean {
  if (event.status === "failed" || event.status === "cancelled") {
    return true;
  }

  if (event.status !== "completed") {
    return false;
  }

  return runType === "ingestion" ? event.phase === "completed" : event.phase === "answered";
}

function allowedTransitionSet(runType: RunType, fromPhase: string): Set<string> {
  if (runType === "ingestion") {
    return ingestionTransitions[fromPhase] ?? new Set<string>();
  }

  return queryTransitions[fromPhase] ?? new Set<string>();
}

function isPhaseForRunType(runType: RunType, phase: string): boolean {
  if (runType === "ingestion") {
    return phase in ingestionTransitions;
  }

  return phase in queryTransitions;
}

export function assertAllowedTransition(
  runType: RunType,
  previousPhase: string | undefined,
  nextPhase: string
): TransitionResult {
  if (!isPhaseForRunType(runType, nextPhase)) {
    return {
      valid: false,
      reason: `phase '${nextPhase}' is not valid for run type '${runType}'`
    };
  }

  if (!previousPhase) {
    if (nextPhase === runStartPhase[runType]) {
      return { valid: true };
    }

    return {
      valid: false,
      reason: `first phase must be '${runStartPhase[runType]}'`
    };
  }

  if (!isPhaseForRunType(runType, previousPhase)) {
    return {
      valid: false,
      reason: `previous phase '${previousPhase}' is not valid for run type '${runType}'`
    };
  }

  // Idempotent progress events may re-emit the same phase after retries/restarts.
  if (previousPhase === nextPhase) {
    return { valid: true };
  }

  const allowed = allowedTransitionSet(runType, previousPhase);
  if (!allowed.has(nextPhase)) {
    return {
      valid: false,
      reason: `transition '${previousPhase}' -> '${nextPhase}' is not allowed`
    };
  }

  return { valid: true };
}

export function hasSingleTerminalEvent(runType: RunType, events: EventEnvelope[]): TransitionResult {
  const terminalCount = events.filter((event) => isTerminalEvent(runType, event)).length;

  if (terminalCount > 1) {
    return {
      valid: false,
      reason: `run has ${terminalCount} terminal events; expected at most 1`
    };
  }

  return { valid: true };
}

export function assertNoEventAfterTerminal(runType: RunType, events: EventEnvelope[]): TransitionResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let terminalSeq: number | undefined;

  for (const event of sorted) {
    if (terminalSeq !== undefined && event.seq > terminalSeq) {
      return {
        valid: false,
        reason: `event with seq ${event.seq} appears after terminal event seq ${terminalSeq}`
      };
    }

    if (isTerminalEvent(runType, event)) {
      terminalSeq = event.seq;
    }
  }

  return { valid: true };
}

export function contiguousTransitionsAreValid(
  runType: RunType,
  events: EventEnvelope[]
): TransitionResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) {
    return { valid: true };
  }

  let previous = sorted[0];
  const firstCheck = assertAllowedTransition(runType, undefined, previous.phase);
  if (!firstCheck.valid) {
    return firstCheck;
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current.seq === previous.seq + 1) {
      const transition = assertAllowedTransition(runType, previous.phase, current.phase);
      if (!transition.valid) {
        return transition;
      }
    }

    previous = current;
  }

  return { valid: true };
}

export function hasDuplicateSequence(events: EventEnvelope[]): TransitionResult {
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.seq)) {
      return {
        valid: false,
        reason: `duplicate sequence number ${event.seq}`
      };
    }
    seen.add(event.seq);
  }

  return { valid: true };
}

export function hasGap(events: EventEnvelope[]): Array<{ expected_seq: number; actual_seq: number }> {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const gaps: Array<{ expected_seq: number; actual_seq: number }> = [];

  for (let index = 1; index < sorted.length; index += 1) {
    const expected = sorted[index - 1].seq + 1;
    if (sorted[index].seq !== expected) {
      gaps.push({ expected_seq: expected, actual_seq: sorted[index].seq });
    }
  }

  return gaps;
}

export function defaultStartPhase(runType: RunType): IngestionPhase | QueryPhase {
  return runStartPhase[runType] as IngestionPhase | QueryPhase;
}
