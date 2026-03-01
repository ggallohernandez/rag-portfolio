import OpenAI from "openai";
import type { EmbeddingBatchResult, EmbeddingResult } from "../../services/contracts.js";

export class OpenAIEmbeddingService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text
    });

    const vector = response.data[0]?.embedding ?? [];
    return {
      vector,
      telemetry: {
        model: this.model,
        provider: "openai",
        dimensions: vector.length,
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
        token_source: "provider"
      }
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        telemetry: {
          model: this.model,
          provider: "openai",
          dimensions: 0,
          prompt_tokens: 0,
          total_tokens: 0,
          token_source: "provider"
        }
      };
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts
    });

    const vectors = response.data.map((item) => item.embedding);
    return {
      vectors,
      telemetry: {
        model: this.model,
        provider: "openai",
        dimensions: vectors[0]?.length ?? 0,
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
        token_source: "provider"
      }
    };
  }
}
