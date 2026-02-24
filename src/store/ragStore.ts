import {
  ChatMemory,
  ChatRecord,
  ChunkRecord,
  DocumentPart,
  DocumentRecord,
  EvalRun,
  EvalSet,
  IngestionJob,
  MessageRecord,
  Project,
  RetrievalTrace
} from "../domain/ragTypes.js";
import { IRagStore } from "./interfaces.js";

export class RagStore implements IRagStore {
  private readonly projects = new Map<string, Project>();
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly documentParts = new Map<string, DocumentPart[]>();
  private readonly chunks = new Map<string, ChunkRecord[]>();
  private readonly ingestionJobs = new Map<string, IngestionJob>();
  private readonly chats = new Map<string, ChatRecord>();
  private readonly chatMessages = new Map<string, MessageRecord[]>();
  private readonly chatMemories = new Map<string, ChatMemory>();
  private readonly traces = new Map<string, RetrievalTrace>();
  private readonly evalSets = new Map<string, EvalSet>();
  private readonly evalRuns = new Map<string, EvalRun>();

  async createProject(project: Project): Promise<Project> {
    this.projects.set(project.id, project);
    return project;
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.projects.get(projectId);
  }

  async createDocument(document: DocumentRecord): Promise<DocumentRecord> {
    this.documents.set(document.id, document);
    return document;
  }

  async updateDocument(documentId: string, patch: Partial<DocumentRecord>): Promise<DocumentRecord> {
    const current = this.documents.get(documentId);
    if (!current) {
      throw new Error(`document '${documentId}' not found`);
    }

    const updated = { ...current, ...patch };
    this.documents.set(documentId, updated);
    return updated;
  }

  async listProjectDocuments(projectId: string): Promise<DocumentRecord[]> {
    return [...this.documents.values()].filter((document) => document.project_id === projectId);
  }

  async getDocument(documentId: string): Promise<DocumentRecord | undefined> {
    return this.documents.get(documentId);
  }

  async upsertDocumentParts(documentId: string, parts: DocumentPart[]): Promise<void> {
    this.documentParts.set(documentId, parts);
  }

  async getDocumentParts(documentId: string): Promise<DocumentPart[]> {
    return [...(this.documentParts.get(documentId) ?? [])];
  }

  async replaceDocumentChunks(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    const projectId = chunks[0]?.project_id;

    if (projectId) {
      const existing = this.chunks.get(projectId) ?? [];
      const filtered = existing.filter((chunk) => chunk.document_id !== documentId);
      this.chunks.set(projectId, [...filtered, ...chunks]);
      return;
    }

    for (const [pid, current] of this.chunks.entries()) {
      this.chunks.set(
        pid,
        current.filter((chunk) => chunk.document_id !== documentId)
      );
    }
  }

  async listProjectChunks(projectId: string): Promise<ChunkRecord[]> {
    return [...(this.chunks.get(projectId) ?? [])];
  }

  async createIngestionJob(job: IngestionJob): Promise<IngestionJob> {
    this.ingestionJobs.set(job.id, job);
    return job;
  }

  async updateIngestionJob(jobId: string, patch: Partial<IngestionJob>): Promise<IngestionJob> {
    const current = this.ingestionJobs.get(jobId);
    if (!current) {
      throw new Error(`ingestion job '${jobId}' not found`);
    }

    const updated = { ...current, ...patch };
    this.ingestionJobs.set(jobId, updated);
    return updated;
  }

  async getIngestionJob(jobId: string): Promise<IngestionJob | undefined> {
    return this.ingestionJobs.get(jobId);
  }

  async listIngestionJobs(projectId: string): Promise<IngestionJob[]> {
    return [...this.ingestionJobs.values()].filter((job) => job.project_id === projectId);
  }

  async createChat(chat: ChatRecord): Promise<ChatRecord> {
    this.chats.set(chat.id, chat);
    if (!this.chatMessages.has(chat.id)) {
      this.chatMessages.set(chat.id, []);
    }

    if (!this.chatMemories.has(chat.id)) {
      this.chatMemories.set(chat.id, {
        chat_id: chat.id,
        rolling_summary: "",
        updated_at: chat.created_at
      });
    }

    return chat;
  }

  async getChat(chatId: string): Promise<ChatRecord | undefined> {
    return this.chats.get(chatId);
  }

  async listProjectChats(projectId: string): Promise<ChatRecord[]> {
    return [...this.chats.values()].filter((chat) => chat.project_id === projectId);
  }

  async addMessage(message: MessageRecord): Promise<MessageRecord> {
    const current = this.chatMessages.get(message.chat_id) ?? [];
    this.chatMessages.set(message.chat_id, [...current, message]);

    const chat = this.chats.get(message.chat_id);
    if (chat) {
      this.chats.set(message.chat_id, {
        ...chat,
        updated_at: message.created_at
      });
    }

    return message;
  }

  async listMessages(chatId: string): Promise<MessageRecord[]> {
    return [...(this.chatMessages.get(chatId) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getMessage(chatId: string, messageId: string): Promise<MessageRecord | undefined> {
    return (this.chatMessages.get(chatId) ?? []).find((message) => message.id === messageId);
  }

  async updateChatMemory(memory: ChatMemory): Promise<ChatMemory> {
    this.chatMemories.set(memory.chat_id, memory);
    return memory;
  }

  async getChatMemory(chatId: string): Promise<ChatMemory | undefined> {
    return this.chatMemories.get(chatId);
  }

  async saveTrace(trace: RetrievalTrace): Promise<RetrievalTrace> {
    this.traces.set(trace.id, trace);
    return trace;
  }

  async getTrace(traceId: string): Promise<RetrievalTrace | undefined> {
    return this.traces.get(traceId);
  }

  async createEvalSet(evalSet: EvalSet): Promise<EvalSet> {
    this.evalSets.set(evalSet.id, evalSet);
    return evalSet;
  }

  async listEvalSets(): Promise<EvalSet[]> {
    return [...this.evalSets.values()];
  }

  async saveEvalRun(run: EvalRun): Promise<EvalRun> {
    this.evalRuns.set(run.id, run);
    return run;
  }

  async listEvalRuns(): Promise<EvalRun[]> {
    return [...this.evalRuns.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
}
