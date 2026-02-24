import { describe, expect, it } from "vitest";
import { AnswerService } from "../src/services/answerService.js";
import { RetrievalCandidate } from "../src/domain/ragTypes.js";

describe("citation references", () => {
  it("prefers source labels for citation location", async () => {
    const service = new AnswerService();
    const candidates: RetrievalCandidate[] = [
      {
        chunk_id: "chunk-a",
        document_id: "doc-a",
        content: "LATU agreement details",
        score: 0.9,
        chunk_index: 0,
        source: "page-3"
      }
    ];

    const result = await service.generateAnswer("What does the agreement say?", candidates);
    expect(result.citations[0].location).toBe("page-3");
  });

  it("falls back to chunk index when source is unavailable", async () => {
    const service = new AnswerService();
    const candidates: RetrievalCandidate[] = [
      {
        chunk_id: "chunk-b",
        document_id: "doc-b",
        content: "Fallback location behavior",
        score: 0.7,
        chunk_index: 4
      }
    ];

    const result = await service.generateAnswer("Where is this?", candidates);
    expect(result.citations[0].location).toBe("chunk-5");
  });
});
