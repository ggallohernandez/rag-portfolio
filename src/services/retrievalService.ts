import { ChunkRecord, RetrievalCandidate } from "../domain/ragTypes.js";
import { IRagStore } from "../store/interfaces.js";
import { tokenize } from "./chunker.js";
import type { EmbeddingGenerator, RetrievalEngine, RetrievalResult } from "./contracts.js";

export class RetrievalService implements RetrievalEngine {
  constructor(
    private readonly ragStore: IRagStore,
    private readonly embeddingService: EmbeddingGenerator
  ) {}

  async retrieve(projectId: string, query: string, k = 8): Promise<RetrievalResult> {
    const queryEmbedding = await this.embeddingService.embed(query);
    const chunks = await this.ragStore.listProjectChunks(projectId);
    if (chunks.length === 0) {
      return {
        vectorCandidates: [],
        bm25Candidates: [],
        fusedCandidates: [],
        rerankedCandidates: [],
        queryEmbedding: queryEmbedding.telemetry
      };
    }

    const vectorCandidates = scoreVector(chunks, queryEmbedding.vector).slice(0, k * 2);
    const bm25Candidates = scoreBm25(chunks, query).slice(0, k * 2);

    const fusedCandidates = rrfFuse(vectorCandidates, bm25Candidates).slice(0, k * 2);
    const rerankedCandidates = rerankCandidates(query, fusedCandidates).slice(0, k);

    return {
      vectorCandidates,
      bm25Candidates,
      fusedCandidates,
      rerankedCandidates,
      queryEmbedding: queryEmbedding.telemetry
    };
  }
}

function scoreVector(chunks: ChunkRecord[], queryVector: number[]): RetrievalCandidate[] {
  return chunks
    .map((chunk) => ({
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      chunk_index: chunk.chunk_index,
      source: sourceFromMetadata(chunk.metadata_json),
      content: chunk.content,
      score: cosineSimilarity(queryVector, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score);
}

function scoreBm25(chunks: ChunkRecord[], query: string): RetrievalCandidate[] {
  const queryTokens = tokenize(query);
  const docTokenSets = chunks.map((chunk) => tokenize(chunk.content));

  const docFreq = new Map<string, number>();
  for (const tokens of docTokenSets) {
    const uniq = new Set(tokens);
    for (const token of uniq) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const avgDocLength =
    docTokenSets.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, docTokenSets.length);

  return chunks
    .map((chunk, index) => {
      const tokens = docTokenSets[index];
      const tf = termFrequency(tokens);
      const score = bm25(queryTokens, tf, tokens.length, avgDocLength, docFreq, chunks.length);

      return {
        chunk_id: chunk.id,
        document_id: chunk.document_id,
        chunk_index: chunk.chunk_index,
        source: sourceFromMetadata(chunk.metadata_json),
        content: chunk.content,
        score
      };
    })
    .sort((a, b) => b.score - a.score);
}

function sourceFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const source = metadata.source;
  return typeof source === "string" && source.trim().length > 0 ? source : undefined;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

function bm25(
  queryTokens: string[],
  tf: Map<string, number>,
  docLength: number,
  avgDocLength: number,
  docFreq: Map<string, number>,
  docCount: number
): number {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;

  for (const token of queryTokens) {
    const termFreq = tf.get(token) ?? 0;
    if (termFreq === 0) {
      continue;
    }

    const n = docFreq.get(token) ?? 0;
    const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLength / Math.max(1, avgDocLength)));

    score += idf * (numerator / denominator);
  }

  return score;
}

function rrfFuse(
  vectorCandidates: RetrievalCandidate[],
  bm25Candidates: RetrievalCandidate[]
): RetrievalCandidate[] {
  const k = 60;
  const fused = new Map<string, RetrievalCandidate>();

  vectorCandidates.forEach((candidate, index) => {
    const key = candidate.chunk_id;
    const existing = fused.get(key);
    const score = (existing?.score ?? 0) + 1 / (k + index + 1);
    fused.set(key, {
      ...candidate,
      score
    });
  });

  bm25Candidates.forEach((candidate, index) => {
    const key = candidate.chunk_id;
    const existing = fused.get(key);
    const score = (existing?.score ?? 0) + 1 / (k + index + 1);
    fused.set(key, {
      ...candidate,
      score
    });
  });

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

function rerankCandidates(query: string, candidates: RetrievalCandidate[]): RetrievalCandidate[] {
  const queryTokens = new Set(tokenize(query));

  return candidates
    .map((candidate) => {
      const chunkTokens = tokenize(candidate.content);
      const overlap = chunkTokens.filter((token) => queryTokens.has(token)).length;
      const rerankedScore = candidate.score + overlap * 0.05;
      return {
        ...candidate,
        score: rerankedScore
      };
    })
    .sort((a, b) => b.score - a.score);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
