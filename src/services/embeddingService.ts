import { tokenize } from "./chunker.js";
import { EmbeddingBatchResult, EmbeddingResult } from "./contracts.js";

export type EmbeddingServiceConfig = {
  dimensions: number;
};

export class EmbeddingService {
  constructor(private readonly config: EmbeddingServiceConfig = { dimensions: 128 }) {}

  async embed(text: string): Promise<EmbeddingResult> {
    const tokens = tokenize(text);
    const vector = new Array<number>(this.config.dimensions).fill(0);

    for (const token of tokens) {
      const hash = hashToken(token);
      const index = Math.abs(hash) % this.config.dimensions;
      vector[index] += 1;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    const normalized = norm === 0 ? vector : vector.map((value) => value / norm);
    return {
      vector: normalized,
      telemetry: {
        model: "deterministic-embedding-v1",
        provider: "deterministic",
        dimensions: this.config.dimensions,
        prompt_tokens: tokens.length,
        total_tokens: tokens.length,
        token_source: "estimated"
      }
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const embedded = await Promise.all(texts.map((text) => this.embed(text)));
    const vectors = embedded.map((item) => item.vector);
    const totalTokens = embedded.reduce((sum, item) => sum + item.telemetry.total_tokens, 0);
    return {
      vectors,
      telemetry: {
        model: "deterministic-embedding-v1",
        provider: "deterministic",
        dimensions: this.config.dimensions,
        prompt_tokens: totalTokens,
        total_tokens: totalTokens,
        token_source: "estimated"
      }
    };
  }
}

function hashToken(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash << 5) - hash + token.charCodeAt(index);
    hash |= 0;
  }

  return hash;
}
