export function costFromPerMillion(tokens: number, usdPerMillionTokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(usdPerMillionTokens) || usdPerMillionTokens <= 0) {
    return 0;
  }

  return roundUsd((tokens / 1_000_000) * usdPerMillionTokens);
}

export function embeddingCostUsd(tokens: number, usdPerMillionTokens: number): number {
  return costFromPerMillion(tokens, usdPerMillionTokens);
}

export function chatCostUsd(
  promptTokens: number,
  completionTokens: number,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number
): number {
  const input = costFromPerMillion(promptTokens, inputUsdPerMillionTokens);
  const output = costFromPerMillion(completionTokens, outputUsdPerMillionTokens);
  return roundUsd(input + output);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
