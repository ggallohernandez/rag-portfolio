import { tokenize } from "./chunker.js";

export type EmbeddingServiceConfig = {
  dimensions: number;
};

export class EmbeddingService {
  constructor(private readonly config: EmbeddingServiceConfig = { dimensions: 128 }) {}

  async embed(text: string): Promise<number[]> {
    const tokens = tokenize(text);
    const vector = new Array<number>(this.config.dimensions).fill(0);

    for (const token of tokens) {
      const hash = hashToken(token);
      const index = Math.abs(hash) % this.config.dimensions;
      vector[index] += 1;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) {
      return vector;
    }

    return vector.map((value) => value / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
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
