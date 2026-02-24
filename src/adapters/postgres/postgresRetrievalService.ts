import { RetrievalCandidate } from "../../domain/ragTypes.js";
import { tokenize } from "../../services/chunker.js";
import { PostgresClient } from "./postgresClient.js";

type RetrievalResult = {
  vectorCandidates: RetrievalCandidate[];
  bm25Candidates: RetrievalCandidate[];
  fusedCandidates: RetrievalCandidate[];
  rerankedCandidates: RetrievalCandidate[];
};

export class PostgresRetrievalService {
  constructor(private readonly db: PostgresClient) {}

  async retrieve(projectId: string, queryEmbedding: number[], query: string, k = 8): Promise<RetrievalResult> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    const vectorRows = await this.db.query<RetrievalCandidate>(
      `select id as chunk_id, document_id, content,
              (1 - (embedding <=> $1::vector))::float as score
       from chunks
       where project_id = $2
         and vector_dims(embedding) = vector_dims($1::vector)
       order by embedding <=> $1::vector asc
       limit $3`,
      [vectorLiteral, projectId, k * 2]
    );

    const bm25Rows = await this.db.query<RetrievalCandidate>(
      `with q as (select plainto_tsquery('english', $1) as query)
       select c.id as chunk_id,
              c.document_id,
              c.content,
              ts_rank(c.tsvector_col, q.query)::float as score
       from chunks c, q
       where c.project_id = $2
         and c.tsvector_col @@ q.query
       order by score desc
       limit $3`,
      [query, projectId, k * 2]
    );

    const fused = rrfFuse(vectorRows.rows, bm25Rows.rows).slice(0, k * 2);
    const reranked = rerank(query, fused).slice(0, k);

    return {
      vectorCandidates: vectorRows.rows,
      bm25Candidates: bm25Rows.rows,
      fusedCandidates: fused,
      rerankedCandidates: reranked
    };
  }
}

function rrfFuse(
  vectorCandidates: RetrievalCandidate[],
  bm25Candidates: RetrievalCandidate[]
): RetrievalCandidate[] {
  const k = 60;
  const fused = new Map<string, RetrievalCandidate>();

  vectorCandidates.forEach((candidate, index) => {
    const score = 1 / (k + index + 1);
    fused.set(candidate.chunk_id, {
      ...candidate,
      score: score + (fused.get(candidate.chunk_id)?.score ?? 0)
    });
  });

  bm25Candidates.forEach((candidate, index) => {
    const score = 1 / (k + index + 1);
    fused.set(candidate.chunk_id, {
      ...candidate,
      score: score + (fused.get(candidate.chunk_id)?.score ?? 0)
    });
  });

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

function rerank(query: string, candidates: RetrievalCandidate[]): RetrievalCandidate[] {
  const queryTokens = new Set(tokenize(query));

  return candidates
    .map((candidate) => {
      const overlap = tokenize(candidate.content).filter((token) => queryTokens.has(token)).length;
      return {
        ...candidate,
        score: candidate.score + overlap * 0.04
      };
    })
    .sort((a, b) => b.score - a.score);
}
