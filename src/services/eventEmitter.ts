import { v4 as uuidv4 } from "uuid";
import { normalizeEventEnvelope, validateCurrentSchema } from "../domain/eventSchema.js";
import { CURRENT_SCHEMA_VERSION, EventEnvelope, EventStatus } from "../domain/types.js";
import { Logger } from "./logger.js";
import { IRunStore } from "../store/interfaces.js";

export type EmitEventInput = {
  run_id: string;
  project_id: string;
  chat_id?: string;
  phase: string;
  status: EventStatus;
  correlation_id: string;
  causation_id?: string;
  payload?: Record<string, unknown>;
  emitted_at?: string;
  seq?: number;
  event_id?: string;
};

export class EventEmitterService {
  constructor(
    private readonly runStore: IRunStore,
    private readonly logger: Logger
  ) {}

  async emit(input: EmitEventInput): Promise<EventEnvelope> {
    const run = await this.runStore.getRunRecord(input.run_id);
    if (!run) {
      throw new Error(`run '${input.run_id}' not found`);
    }

    const state = await this.runStore.getRunState(input.project_id, input.run_id);
    const seq = input.seq ?? (state?.last_seq ?? 0) + 1;

    const rawEvent = {
      event_id: input.event_id ?? uuidv4(),
      run_id: input.run_id,
      project_id: input.project_id,
      chat_id: input.chat_id,
      phase: input.phase,
      status: input.status,
      seq,
      emitted_at: input.emitted_at ?? new Date().toISOString(),
      correlation_id: input.correlation_id,
      causation_id: input.causation_id,
      schema_version: CURRENT_SCHEMA_VERSION,
      payload: input.payload ?? {}
    };

    const normalized = normalizeEventEnvelope(rawEvent);
    validateCurrentSchema(normalized);

    const result = await this.runStore.appendEvent(normalized);

    if (result.duplicate) {
      this.logger.info("duplicate event ignored", {
        run_id: normalized.run_id,
        seq: normalized.seq,
        correlation_id: normalized.correlation_id
      });
      const existing = (await this.runStore.getRunEvents(normalized.project_id, normalized.run_id)).find(
        (event) => event.seq === normalized.seq
      );
      if (existing) {
        return existing;
      }
    }

    this.logger.info("event persisted", {
      run_id: normalized.run_id,
      phase: normalized.phase,
      status: normalized.status,
      seq: normalized.seq,
      correlation_id: normalized.correlation_id
    });

    return normalized;
  }
}
