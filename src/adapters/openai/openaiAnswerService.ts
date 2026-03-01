import OpenAI from "openai";
import { GeneratedAnswer } from "../../services/answerService.js";
import { RetrievalCandidate } from "../../domain/ragTypes.js";

export class OpenAIAnswerService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async generateAnswer(query: string, candidates: RetrievalCandidate[]): Promise<GeneratedAnswer> {
    const contextCandidates = candidates.slice(0, 8);
    const context = contextCandidates
      .slice(0, 8)
      .map(
        (candidate, index) =>
          `[#${index + 1}] chunk_id=${candidate.chunk_id} doc=${candidate.document_id}\n${candidate.content}`
      )
      .join("\n\n");

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a retrieval-augmented assistant. Use only provided context. Be concise and factual. Include references as [#n]."
        },
        {
          role: "user",
          content: `Question: ${query}\n\nContext:\n${context || "(no context)"}`
        }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim() ?? "I could not produce an answer.";

    const citations = buildCitationsFromAnswer(answer, contextCandidates);

    const usage = completion.usage;
    return {
      answer,
      citations,
      token_usage_json: {
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0
      },
      model: this.model
    };
  }
}

function buildCitationsFromAnswer(answer: string, contextCandidates: RetrievalCandidate[]) {
  const references = extractReferenceIndices(answer, contextCandidates.length);
  const selected =
    references.length > 0
      ? references.map((reference) => ({
          candidate: contextCandidates[reference - 1],
          sourceIndex: reference
        }))
      : contextCandidates.map((candidate, index) => ({ candidate, sourceIndex: index + 1 }));

  return selected
    .filter((item) => item.candidate)
    .map(({ candidate, sourceIndex }) => ({
      document_id: candidate.document_id,
      chunk_id: candidate.chunk_id,
      preview: candidate.content.slice(0, 180),
      location: buildCitationLocation(candidate),
      source_index: sourceIndex
    }));
}

function extractReferenceIndices(answer: string, maxReference: number): number[] {
  const seen = new Set<number>();
  const references: number[] = [];
  const regex = /\[#(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(answer)) !== null) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > maxReference || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    references.push(parsed);
  }

  return references;
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
