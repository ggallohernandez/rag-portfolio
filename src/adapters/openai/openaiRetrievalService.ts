import { PostgresRetrievalService } from "../postgres/postgresRetrievalService.js";
import { RetrievalEngine, RetrievalResult } from "../../services/contracts.js";
import { OpenAIEmbeddingService } from "./openaiEmbeddingService.js";

export class OpenAIRetrievalService implements RetrievalEngine {
  constructor(
    private readonly postgresRetriever: PostgresRetrievalService,
    private readonly embeddingService: OpenAIEmbeddingService
  ) {}

  async retrieve(projectId: string, query: string, k = 8): Promise<RetrievalResult> {
    const embedding = await this.embeddingService.embed(query);
    return this.postgresRetriever.retrieve(projectId, embedding, query, k);
  }
}
