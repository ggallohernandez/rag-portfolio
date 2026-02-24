import { EventEmitterService } from "./eventEmitter.js";
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { IRunStore } from "../store/interfaces.js";

export type ReconcilerConfig = {
  staleThresholdMs: number;
  now: () => number;
};

export class ReconciliationWorker {
  constructor(
    private readonly store: IRunStore,
    private readonly eventEmitter: EventEmitterService,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry,
    private readonly config: ReconcilerConfig
  ) {}

  async reconcile(): Promise<void> {
    const openRuns = await this.store.listNonTerminalRuns();

    for (const run of openRuns) {
      const heartbeat = await this.store.getHeartbeat(run.run_id);
      if (!heartbeat) {
        continue;
      }

      const ageMs = this.config.now() - new Date(heartbeat).getTime();
      const stale = ageMs > this.config.staleThresholdMs;

      if (stale) {
        this.metrics.increment("terminal_missing_total");
        await this.eventEmitter.emit({
          run_id: run.run_id,
          project_id: run.project_id,
          chat_id: run.chat_id,
          phase: "failed",
          status: "failed",
          correlation_id: `reconcile:${run.run_id}`,
          payload: {
            error: "reconciliation marked stale run as failed",
            synthetic: true,
            stale_age_ms: ageMs
          }
        });
        this.logger.error("reconciliation failed stale run", {
          run_id: run.run_id,
          stale_age_ms: ageMs
        });
      } else {
        this.logger.info("reconciliation observed active run", {
          run_id: run.run_id,
          current_phase: run.current_phase
        });
      }
    }
  }
}
