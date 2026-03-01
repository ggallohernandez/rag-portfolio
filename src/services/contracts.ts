import { GeneratedAnswer } from "./answerService.js";
import { RetrievalCandidate } from "../domain/ragTypes.js";

export type TokenSource = "provider" | "estimated";

export type EmbeddingTelemetry = {
  model: string;
  provider: string;
  dimensions: number;
  prompt_tokens: number;
  total_tokens: number;
  token_source: TokenSource;
};

export type EmbeddingResult = {
  vector: number[];
  telemetry: EmbeddingTelemetry;
};

export type EmbeddingBatchResult = {
  vectors: number[][];
  telemetry: EmbeddingTelemetry;
};

export type RetrievalResult = {
  vectorCandidates: RetrievalCandidate[];
  bm25Candidates: RetrievalCandidate[];
  fusedCandidates: RetrievalCandidate[];
  rerankedCandidates: RetrievalCandidate[];
  queryEmbedding: EmbeddingTelemetry;
};

export interface RetrievalEngine {
  retrieve(projectId: string, query: string, k?: number): Promise<RetrievalResult>;
}

export interface AnswerGenerator {
  generateAnswer(query: string, candidates: RetrievalCandidate[]): Promise<GeneratedAnswer>;
}

export interface EmbeddingGenerator {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;
}
