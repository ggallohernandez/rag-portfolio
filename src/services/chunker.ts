import { v4 as uuidv4 } from "uuid";
import { ChunkRecord, DocumentPart } from "../domain/ragTypes.js";

export type ChunkConfig = {
  targetTokens: number;
  overlapTokens: number;
  maxTokens: number;
};

export const defaultChunkConfig: ChunkConfig = {
  targetTokens: 500,
  overlapTokens: 80,
  maxTokens: 900
};

export function chunkDocumentParts(
  projectId: string,
  documentId: string,
  parts: DocumentPart[],
  config: ChunkConfig = defaultChunkConfig
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  let chunkIndex = 0;

  for (const part of parts) {
    const tokens = tokenize(part.raw_text);
    if (tokens.length === 0) {
      continue;
    }

    let cursor = 0;
    while (cursor < tokens.length) {
      const windowSize = Math.min(config.targetTokens, config.maxTokens);
      const next = Math.min(tokens.length, cursor + windowSize);
      const slice = tokens.slice(cursor, next);

      if (slice.length === 0) {
        break;
      }

      const content = slice.join(" ");
      chunks.push({
        id: uuidv4(),
        project_id: projectId,
        document_id: documentId,
        chunk_index: chunkIndex,
        content,
        token_count: slice.length,
        embedding: [],
        metadata_json: {
          source: part.page_or_sheet,
          ...part.metadata_json
        },
        tsvector_col: normalizeForSearch(content)
      });

      chunkIndex += 1;
      if (next >= tokens.length) {
        break;
      }

      cursor = Math.max(0, next - config.overlapTokens);
    }
  }

  return chunks;
}

export function normalizeForSearch(value: string): string {
  return tokenize(value).join(" ");
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
