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
import { DeadLetterJob, EventEnvelope, RunState, RunTrace, RunType } from "../domain/types.js";

export type RunRecord = {
  run_id: string;
  project_id: string;
  run_type: RunType;
  chat_id?: string;
};

export type AppendResult = {
  inserted: boolean;
  duplicate: boolean;
  out_of_order: boolean;
};

export type RunEventSubscriber = (event: EventEnvelope) => void;

export interface IRunStore {
  createProject(projectId: string): Promise<void>;
  hasProject(projectId: string): Promise<boolean>;
  createRun(record: RunRecord): Promise<RunState>;
  getRunRecord(runId: string): Promise<RunRecord | undefined>;
  getRunState(projectId: string, runId: string): Promise<RunState | undefined>;
  getRunEvents(projectId: string, runId: string): Promise<EventEnvelope[]>;
  getEventById(runId: string, eventId: string): Promise<EventEnvelope | undefined>;
  appendEvent(event: EventEnvelope): Promise<AppendResult>;
  subscribeToRunEvents(runId: string, handler: RunEventSubscriber): () => void;
  listNonTerminalRuns(): Promise<RunState[]>;
  getHeartbeat(runId: string): Promise<string | undefined>;
  setHeartbeat(runId: string, value: string): Promise<void>;
  getRunTrace(projectId: string, runId: string): Promise<RunTrace | undefined>;
  addDeadLetterJob(job: DeadLetterJob): Promise<void>;
  listDeadLetterJobs(): Promise<DeadLetterJob[]>;
}

export interface IRagStore {
  createProject(project: Project): Promise<Project>;
  updateProject(projectId: string, patch: Partial<Pick<Project, "name" | "description">>): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project | undefined>;

  createDocument(document: DocumentRecord): Promise<DocumentRecord>;
  updateDocument(documentId: string, patch: Partial<DocumentRecord>): Promise<DocumentRecord>;
  listProjectDocuments(projectId: string): Promise<DocumentRecord[]>;
  getDocument(documentId: string): Promise<DocumentRecord | undefined>;

  upsertDocumentParts(documentId: string, parts: DocumentPart[]): Promise<void>;
  getDocumentParts(documentId: string): Promise<DocumentPart[]>;

  replaceDocumentChunks(documentId: string, chunks: ChunkRecord[]): Promise<void>;
  listProjectChunks(projectId: string): Promise<ChunkRecord[]>;

  createIngestionJob(job: IngestionJob): Promise<IngestionJob>;
  updateIngestionJob(jobId: string, patch: Partial<IngestionJob>): Promise<IngestionJob>;
  getIngestionJob(jobId: string): Promise<IngestionJob | undefined>;
  listIngestionJobs(projectId: string): Promise<IngestionJob[]>;

  createChat(chat: ChatRecord): Promise<ChatRecord>;
  updateChat(chatId: string, patch: Partial<Pick<ChatRecord, "title" | "updated_at">>): Promise<ChatRecord>;
  deleteChat(chatId: string): Promise<void>;
  getChat(chatId: string): Promise<ChatRecord | undefined>;
  listProjectChats(projectId: string): Promise<ChatRecord[]>;

  addMessage(message: MessageRecord): Promise<MessageRecord>;
  listMessages(chatId: string): Promise<MessageRecord[]>;
  getMessage(chatId: string, messageId: string): Promise<MessageRecord | undefined>;

  updateChatMemory(memory: ChatMemory): Promise<ChatMemory>;
  getChatMemory(chatId: string): Promise<ChatMemory | undefined>;

  saveTrace(trace: RetrievalTrace): Promise<RetrievalTrace>;
  getTrace(traceId: string): Promise<RetrievalTrace | undefined>;

  createEvalSet(evalSet: EvalSet): Promise<EvalSet>;
  listEvalSets(): Promise<EvalSet[]>;

  saveEvalRun(run: EvalRun): Promise<EvalRun>;
  listEvalRuns(): Promise<EvalRun[]>;
}
