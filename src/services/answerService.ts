import { Citation, RetrievalCandidate } from "../domain/ragTypes.js";

export type GeneratedAnswer = {
  answer: string;
  citations: Citation[];
  token_usage_json: Record<string, number>;
  model: string;
};

export class AnswerService {
  async generateAnswer(query: string, candidates: RetrievalCandidate[]): Promise<GeneratedAnswer> {
    if (candidates.length === 0) {
      return {
        answer: `I could not find grounded evidence for: ${query}`,
        citations: [],
        token_usage_json: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        },
        model: "deterministic-rag"
      };
    }

    const top = candidates.slice(0, 3);
    const evidence = top.map((candidate) => candidate.content.slice(0, 220));

    const answer =
      `Based on the indexed dataset, here is the best grounded response for "${query}":\n\n` +
      evidence.map((line, index) => `${index + 1}. ${line} [#${index + 1}]`).join("\n");

    const citations: Citation[] = top.map((candidate, index) => ({
      document_id: candidate.document_id,
      chunk_id: candidate.chunk_id,
      preview: candidate.content.slice(0, 180),
      location: buildCitationLocation(candidate),
      source_index: index + 1
    }));

    const promptTokens = Math.max(1, Math.floor(query.length / 4));
    const completionTokens = Math.max(1, Math.floor(answer.length / 4));

    return {
      answer,
      citations,
      token_usage_json: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      },
      model: "deterministic-rag"
    };
  }
}

function buildCitationLocation(candidate: RetrievalCandidate): string {
  if (candidate.source && candidate.source.trim().length > 0) {
    return candidate.source;
  }

  if (typeof candidate.chunk_index === "number") {
    return `chunk-${candidate.chunk_index + 1}`;
  }

  return "chunk";
}
