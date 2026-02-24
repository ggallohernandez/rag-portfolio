import { v4 as uuidv4 } from "uuid";
import { ChatMemoryService } from "./chatMemoryService.js";
import { EventEmitterService } from "./eventEmitter.js";
import { IRagStore, IRunStore } from "../store/interfaces.js";
import { MessageRecord, RetrievalTrace } from "../domain/ragTypes.js";
import { defaultStartPhase } from "../domain/stateMachine.js";
import { AnswerGenerator, RetrievalEngine } from "./contracts.js";

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
    private readonly memoryService: ChatMemoryService
  ) {}

  async ask(projectId: string, chatId: string, content: string): Promise<QueryResult> {
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

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "query_embedded",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        message_id: userMessage.id
      }
    });

    const retrieval = await this.retrievalService.retrieve(projectId, content);

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "retrieved_vector",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        count: retrieval.vectorCandidates.length
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
        count: retrieval.bm25Candidates.length
      }
    });

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "reranked",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        count: retrieval.rerankedCandidates.length
      }
    });

    const context = await this.memoryService.buildPromptContext(chatId);

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "context_built",
      status: "in_progress",
      correlation_id: correlationId,
      payload: {
        summary_chars: context.summary.length,
        recent_turns: context.recentMessages.length
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
        estimated_tokens: generated.token_usage_json.total_tokens
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
      model: "deterministic-rag",
      token_usage_json: generated.token_usage_json,
      created_at: new Date().toISOString(),
      retrieval_trace_id: trace.id
    };

    trace.message_id = assistantMessage.id;

    await this.ragStore.addMessage(assistantMessage);
    await this.ragStore.saveTrace(trace);

    await this.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: "answered",
      status: "completed",
      correlation_id: correlationId,
      payload: {
        message_id: assistantMessage.id,
        citations: generated.citations.length
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
