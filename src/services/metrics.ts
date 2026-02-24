export type CounterName =
  | "out_of_order_events_total"
  | "duplicate_events_total"
  | "run_timeout_total"
  | "replay_count"
  | "terminal_missing_total";

export type HistogramName = "event_lag_ms";

export class MetricsRegistry {
  private counters: Record<CounterName, number> = {
    out_of_order_events_total: 0,
    duplicate_events_total: 0,
    run_timeout_total: 0,
    replay_count: 0,
    terminal_missing_total: 0
  };

  private histograms: Record<HistogramName, number[]> = {
    event_lag_ms: []
  };

  increment(name: CounterName, by = 1): void {
    this.counters[name] += by;
  }

  observe(name: HistogramName, value: number): void {
    this.histograms[name].push(value);
  }

  snapshot(): {
    counters: Record<CounterName, number>;
    histograms: Record<HistogramName, number[]>;
  } {
    return {
      counters: { ...this.counters },
      histograms: {
        event_lag_ms: [...this.histograms.event_lag_ms]
      }
    };
  }
}
