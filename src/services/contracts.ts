import { GeneratedAnswer } from "./answerService.js";
import { RetrievalCandidate } from "../domain/ragTypes.js";

export type RetrievalResult = {
  vectorCandidates: RetrievalCandidate[];
  bm25Candidates: RetrievalCandidate[];
  fusedCandidates: RetrievalCandidate[];
  rerankedCandidates: RetrievalCandidate[];
};

export interface RetrievalEngine {
  retrieve(projectId: string, query: string, k?: number): Promise<RetrievalResult>;
}

export interface AnswerGenerator {
  generateAnswer(query: string, candidates: RetrievalCandidate[]): Promise<GeneratedAnswer>;
}

export interface EmbeddingGenerator {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
