export type HistogramBin = {
  range_label: string;
  count: number;
};

export type ChunkDistributionSummary = {
  chunk_count: number;
  token_min: number;
  token_max: number;
  token_avg: number;
  histogram_bins: HistogramBin[];
};

export function summarizeChunkTokens(tokenCounts: number[], binSize = 100): ChunkDistributionSummary {
  if (tokenCounts.length === 0) {
    return {
      chunk_count: 0,
      token_min: 0,
      token_max: 0,
      token_avg: 0,
      histogram_bins: []
    };
  }

  const token_min = Math.min(...tokenCounts);
  const token_max = Math.max(...tokenCounts);
  const token_avg = Math.round((tokenCounts.reduce((sum, count) => sum + count, 0) / tokenCounts.length) * 100) / 100;
  const histogram_bins = buildHistogramBins(tokenCounts, binSize);

  return {
    chunk_count: tokenCounts.length,
    token_min,
    token_max,
    token_avg,
    histogram_bins
  };
}

export function buildHistogramBins(tokenCounts: number[], binSize = 100): HistogramBin[] {
  if (tokenCounts.length === 0) {
    return [];
  }

  const safeBinSize = Number.isFinite(binSize) && binSize > 0 ? Math.floor(binSize) : 100;
  const maxValue = Math.max(...tokenCounts);
  const bucketCount = Math.floor(maxValue / safeBinSize) + 1;
  const bins = new Array<number>(bucketCount).fill(0);

  for (const count of tokenCounts) {
    const value = Math.max(0, Math.floor(count));
    const index = Math.floor(value / safeBinSize);
    bins[index] += 1;
  }

  return bins.map((count, index) => {
    const start = index * safeBinSize;
    const end = start + safeBinSize - 1;
    return {
      range_label: `${start}-${end}`,
      count
    };
  });
}
