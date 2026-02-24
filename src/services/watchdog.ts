import { EventEmitterService } from "./eventEmitter.js";
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { IRunStore } from "../store/interfaces.js";

export type WatchdogConfig = {
  staleThresholdMs: number;
  now: () => number;
};

export class RunWatchdog {
  constructor(
    private readonly store: IRunStore,
    private readonly eventEmitter: EventEmitterService,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
    private readonly config: WatchdogConfig
  ) {}

  async scan(): Promise<void> {
    const runs = await this.store.listNonTerminalRuns();

    for (const run of runs) {
      const heartbeatIso = await this.store.getHeartbeat(run.run_id);
      if (!heartbeatIso) {
        continue;
      }

      const heartbeatMs = new Date(heartbeatIso).getTime();
      const age = this.config.now() - heartbeatMs;

      if (age <= this.config.staleThresholdMs) {
        continue;
      }

      const correlationId = `watchdog:${run.run_id}`;
      try {
        await this.eventEmitter.emit({
          run_id: run.run_id,
          project_id: run.project_id,
          chat_id: run.chat_id,
          phase: "failed",
          status: "failed",
          correlation_id: correlationId,
          payload: {
            error: `run heartbeat exceeded stale threshold (${this.config.staleThresholdMs}ms)`,
            synthetic: true
          }
        });

        this.metrics.increment("run_timeout_total");
        this.logger.error("watchdog terminated stale run", {
          run_id: run.run_id,
          project_id: run.project_id,
          correlation_id: correlationId,
          seq: run.last_seq + 1
        });
      } catch (error) {
        this.logger.error("watchdog failed to terminate stale run", {
          run_id: run.run_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
