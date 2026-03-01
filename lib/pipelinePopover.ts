export type HistogramLinePoint = {
  range: string;
  count: number;
};

export function formatBytes(value: unknown): string {
  const bytes = toNumber(value);
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const base = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** base;
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(precision)} ${units[base]}`;
}

export function formatUsd(value: unknown): string {
  const usd = toNumber(value);
  return `$${usd.toFixed(4)}`;
}

export function formatPercent(value: unknown): string {
  const pct = toNumber(value);
  return `${pct.toFixed(2)}%`;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function buildHistogramLineData(histogramBins: unknown): HistogramLinePoint[] {
  if (!Array.isArray(histogramBins)) {
    return [];
  }

  return histogramBins
    .map((bin) => {
      const candidate = bin as { range_label?: unknown; count?: unknown };
      const range = typeof candidate.range_label === "string" ? candidate.range_label : "n/a";
      const count = toNumber(candidate.count);
      return {
        range,
        count
      };
    })
    .filter((item) => item.count >= 0);
}

export function safeText(value: unknown, fallback = "Not available."): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}
