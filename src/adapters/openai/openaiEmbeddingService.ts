import OpenAI from "openai";

export class OpenAIEmbeddingService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text
    });

    return response.data[0]?.embedding ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts
    });

    return response.data.map((item) => item.embedding);
  }
}
