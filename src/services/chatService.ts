import { v4 as uuidv4 } from "uuid";
import { ChatMemoryService } from "./chatMemoryService.js";
import { EventEmitterService } from "./eventEmitter.js";
import { IRagStore, IRunStore } from "../store/interfaces.js";
import { MessageRecord, RetrievalTrace } from "../domain/ragTypes.js";
import { defaultStartPhase } from "../domain/stateMachine.js";
import type { AnswerGenerator, RetrievalEngine } from "./contracts.js";
import { chatCostUsd, embeddingCostUsd } from "./costing.js";
import { redactAndTruncateContext } from "./redaction.js";

export type QueryResult = {
  runId: string;
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  trace: RetrievalTrace;
};

export class ChatService {
  constructor(
    private readonly ragStore: IRagStore,
    private readonly runStore: IRunStore,
    private readonly emitter: EventEmitterService,
    private readonly retrievalService: RetrievalEngine,
    private readonly answerService: AnswerGenerator,
    private readonly memoryService: ChatMemoryService,
    private readonly telemetryConfig: {
      embeddingUsdPer1MTokens: number;
      chatInputUsdPer1MTokens: number;
      chatOutputUsdPer1MTokens: number;
      contextMaxChars: number;
      contextRedactionEnabled: boolean;
    }
  ) {}

  async ask(projectId: string, chatId: string, content: string): Promise<QueryResult> {
    const queryStartedAt = Date.now();
    const chat = await this.ragStore.getChat(chatId);
    if (!chat || chat.project_id !== projectId) {
      throw new Error(`chat '${chatId}' not found in project '${projectId}'`);
    }

    const now = new Date().toISOString();
    const userMessage: MessageRecord = {
      id: uuidv4(),
      chat_id: chatId,
      role: "user",
      content,
      citations_json: [],
      model: "user",
      token_usage_json: {},
      created_at: now
    };

    await this.ragStore.addMessage(userMessage);

    const runId = uuidv4();
    await this.runStore.createRun({
      run_id: runId,
      project_id: projectId,
      run_type: "query",
      chat_id: chatId
    });

    const correlationId = `query:${runId}`;

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: defaultStartPhase("query"),
      status: "started",
      correlation_id: correlationId,
      payload: {
        chat_id: chatId,
        message_id: userMessage.id
      }
    });

    const retrieval = await this.retrievalService.retrieve(projectId, content);
    const queryEmbeddingCostUsd = embeddingCostUsd(
      retrieval.queryEmbedding.total_tokens,
      this.telemetryConfig.embeddingUsdPer1MTokens
    );

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "query_embedded",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        message_id: userMessage.id,
        embedding_model: retrieval.queryEmbedding.model,
        embedding_provider: retrieval.queryEmbedding.provider,
        embedding_dimensions: retrieval.queryEmbedding.dimensions,
        embedding_prompt_tokens: retrieval.queryEmbedding.prompt_tokens,
        embedding_total_tokens: retrieval.queryEmbedding.total_tokens,
        embedding_cost_usd: queryEmbeddingCostUsd,
        token_source: retrieval.queryEmbedding.token_source
      }
    });

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "retrieved_vector",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        count: retrieval.vectorCandidates.length,
        candidates: retrieval.vectorCandidates.slice(0, 8).map((candidate) => ({
          chunk_id: candidate.chunk_id,
          document_id: candidate.document_id,
          score: candidate.score,
          source: candidate.source,
          preview: candidate.content.slice(0, 180)
        }))
      }
    });

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "retrieved_bm25",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        count: retrieval.bm25Candidates.length,
        candidates: retrieval.bm25Candidates.slice(0, 8).map((candidate) => ({
          chunk_id: candidate.chunk_id,
          document_id: candidate.document_id,
          score: candidate.score,
          source: candidate.source,
          preview: candidate.content.slice(0, 180)
        }))
      }
    });

    const vectorChunkIds = new Set(retrieval.vectorCandidates.map((candidate) => candidate.chunk_id));
    const bm25ChunkIds = new Set(retrieval.bm25Candidates.map((candidate) => candidate.chunk_id));

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "reranked",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        count: retrieval.rerankedCandidates.length,
        candidates: retrieval.rerankedCandidates.slice(0, 8).map((candidate) => ({
          chunk_id: candidate.chunk_id,
          document_id: candidate.document_id,
          score: candidate.score,
          source: candidate.source,
          preview: candidate.content.slice(0, 180),
          retrieval_origin: classifyRetrievalOrigin(candidate.chunk_id, vectorChunkIds, bm25ChunkIds)
        }))
      }
    });

    const context = await this.memoryService.buildPromptContext(chatId);
    const rawContext = [
      context.summary ? `Summary:\n${context.summary}` : "",
      context.recentMessages.length > 0
        ? `Recent turns:\n${context.recentMessages
            .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
            .join("\n")}`
        : ""
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const redactedContext = redactAndTruncateContext(rawContext, {
      maxChars: this.telemetryConfig.contextMaxChars,
      enabled: this.telemetryConfig.contextRedactionEnabled
    });

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "context_built",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        summary_chars: context.summary.length,
        recent_turns: context.recentMessages.length,
        context_preview: redactedContext.preview,
        context_full_redacted: redactedContext.full,
        context_truncated: redactedContext.truncated,
        context_redaction_applied: redactedContext.redactionApplied
      }
    });

    const generated = await this.answerService.generateAnswer(content, retrieval.rerankedCandidates);

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "answer_streaming",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        estimated_tokens: generated.token_usage_json.total_tokens,
        answer_model: generated.model
      }
    });

    const trace: RetrievalTrace = {
      id: uuidv4(),
      project_id: projectId,
      chat_id: chatId,
      message_id: "",
      query: content,
      created_at: new Date().toISOString(),
      vector_candidates: retrieval.vectorCandidates,
      bm25_candidates: retrieval.bm25Candidates,
      fused_candidates: retrieval.fusedCandidates,
      reranked_candidates: retrieval.rerankedCandidates,
      citations: generated.citations
    };

    const assistantMessage: MessageRecord = {
      id: uuidv4(),
      chat_id: chatId,
      role: "assistant",
      content: generated.answer,
      citations_json: generated.citations,
      model: generated.model,
      token_usage_json: generated.token_usage_json,
      created_at: new Date().toISOString(),
      retrieval_trace_id: trace.id
    };

    trace.message_id = assistantMessage.id;

    await this.ragStore.addMessage(assistantMessage);
    await this.ragStore.saveTrace(trace);

    const answerPromptTokens = toNumber(generated.token_usage_json.prompt_tokens);
    const answerCompletionTokens = toNumber(generated.token_usage_json.completion_tokens);
    const answerTotalTokens = toNumber(generated.token_usage_json.total_tokens);
    const answerCostUsd = chatCostUsd(
      answerPromptTokens,
      answerCompletionTokens,
      this.telemetryConfig.chatInputUsdPer1MTokens,
      this.telemetryConfig.chatOutputUsdPer1MTokens
    );
    const totalCostUsd = Math.round((answerCostUsd + queryEmbeddingCostUsd) * 1_000_000) / 1_000_000;
    const answerLatencyMs = Math.max(0, Date.now() - queryStartedAt);

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "answered",
      status: "completed",
      correlation_id: correlationId,
      payload: {
        message_id: assistantMessage.id,
        citations: generated.citations.length,
        answer_model: generated.model,
        answer_prompt_tokens: answerPromptTokens,
        answer_completion_tokens: answerCompletionTokens,
        answer_total_tokens: answerTotalTokens,
        answer_cost_usd: answerCostUsd,
        query_embedding_tokens: retrieval.queryEmbedding.total_tokens,
        query_embedding_cost_usd: queryEmbeddingCostUsd,
        total_cost_usd: totalCostUsd,
        answer_latency_ms: answerLatencyMs
      }
    });

    await this.memoryService.updateRollingSummary(chatId);

    return {
      runId,
      userMessage,
      assistantMessage,
      trace
    };
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return 0;
}

function classifyRetrievalOrigin(
  chunkId: string,
  vectorChunkIds: Set<string>,
  bm25ChunkIds: Set<string>
): "both" | "vector" | "bm25" | "unknown" {
  const inVector = vectorChunkIds.has(chunkId);
  const inBm25 = bm25ChunkIds.has(chunkId);

  if (inVector && inBm25) {
    return "both";
  }

  if (inVector) {
    return "vector";
  }

  if (inBm25) {
    return "bm25";
  }

  return "unknown";
}
