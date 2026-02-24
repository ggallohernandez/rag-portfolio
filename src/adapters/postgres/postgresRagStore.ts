import { PoolClient } from "pg";
import {
  ChatMemory,
  ChatRecord,
  ChunkRecord,
  Citation,
  DocumentPart,
  DocumentRecord,
  EvalRun,
  EvalSet,
  IngestionJob,
  MessageRecord,
  Project,
  RetrievalCandidate,
  RetrievalTrace
} from "../../domain/ragTypes.js";
import { IRagStore } from "../../store/interfaces.js";
import { PostgresClient } from "./postgresClient.js";

export class PostgresRagStore implements IRagStore {
  constructor(private readonly db: PostgresClient) {}

  async createProject(project: Project): Promise<Project> {
    await this.db.query(
      `insert into projects (id, name, description, created_at)
       values ($1, $2, $3, $4)
       on conflict (id) do update set name = excluded.name, description = excluded.description`,
      [project.id, project.name, project.description ?? null, project.created_at]
    );

    return project;
  }

  async listProjects(): Promise<Project[]> {
    const result = await this.db.query<Project>(
      `select id, name, description, created_at::text
       from projects
       order by created_at asc`
    );

    return result.rows;
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    const result = await this.db.query<Project>(
      `select id, name, description, created_at::text
       from projects where id = $1 limit 1`,
      [projectId]
    );

    return result.rows[0];
  }

  async createDocument(document: DocumentRecord): Promise<DocumentRecord> {
    await this.db.query(
      `insert into documents (id, project_id, filename, mime_type, object_key, parse_status, ocr_status, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        document.id,
        document.project_id,
        document.filename,
        document.mime_type,
        document.object_key,
        document.parse_status,
        document.ocr_status,
        document.created_at
      ]
    );

    return document;
  }

  async updateDocument(documentId: string, patch: Partial<DocumentRecord>): Promise<DocumentRecord> {
    const current = await this.getDocument(documentId);
    if (!current) {
      throw new Error(`document '${documentId}' not found`);
    }

    const next: DocumentRecord = { ...current, ...patch };
    await this.db.query(
      `update documents
       set filename = $2,
           mime_type = $3,
           object_key = $4,
           parse_status = $5,
           ocr_status = $6
       where id = $1`,
      [next.id, next.filename, next.mime_type, next.object_key, next.parse_status, next.ocr_status]
    );

    return next;
  }

  async listProjectDocuments(projectId: string): Promise<DocumentRecord[]> {
    const result = await this.db.query<DocumentRecord>(
      `select id, project_id, filename, mime_type, object_key, parse_status, ocr_status, created_at::text
       from documents
       where project_id = $1
       order by created_at asc`,
      [projectId]
    );

    return result.rows;
  }

  async getDocument(documentId: string): Promise<DocumentRecord | undefined> {
    const result = await this.db.query<DocumentRecord>(
      `select id, project_id, filename, mime_type, object_key, parse_status, ocr_status, created_at::text
       from documents
       where id = $1
       limit 1`,
      [documentId]
    );

    return result.rows[0];
  }

  async upsertDocumentParts(documentId: string, parts: DocumentPart[]): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(`delete from document_parts where document_id = $1`, [documentId]);

      for (const part of parts) {
        await client.query(
          `insert into document_parts (id, document_id, page_or_sheet, raw_text, metadata_json)
           values ($1, $2, $3, $4, $5::jsonb)`,
          [part.id, part.document_id, part.page_or_sheet, part.raw_text, JSON.stringify(part.metadata_json)]
        );
      }
    });
  }

  async getDocumentParts(documentId: string): Promise<DocumentPart[]> {
    const result = await this.db.query<
      Omit<DocumentPart, "metadata_json"> & { metadata_json: string | Record<string, unknown> }
    >(
      `select id, document_id, page_or_sheet, raw_text, metadata_json
       from document_parts
       where document_id = $1
       order by page_or_sheet asc`,
      [documentId]
    );

    return result.rows.map((row) => ({
      ...row,
      metadata_json: normalizeJson(row.metadata_json)
    }));
  }

  async replaceDocumentChunks(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(`delete from chunks where document_id = $1`, [documentId]);

      for (const chunk of chunks) {
        await insertChunk(client, chunk);
      }
    });
  }

  async listProjectChunks(projectId: string): Promise<ChunkRecord[]> {
    const result = await this.db.query<
      Omit<ChunkRecord, "metadata_json" | "embedding"> & {
        metadata_json: string | Record<string, unknown>;
        embedding: string | number[] | null;
      }
    >(
      `select id, project_id, document_id, chunk_index, content, token_count, embedding, metadata_json, tsvector_col::text
       from chunks
       where project_id = $1
       order by chunk_index asc`,
      [projectId]
    );

    return result.rows.map((row) => ({
      ...row,
      embedding: parseVector(row.embedding),
      metadata_json: normalizeJson(row.metadata_json)
    }));
  }

  async createIngestionJob(job: IngestionJob): Promise<IngestionJob> {
    await this.db.query(
      `insert into ingestion_jobs (id, run_id, project_id, document_id, status, error, started_at, ended_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job.id, job.run_id, job.project_id, job.document_id, job.status, job.error ?? null, null, null]
    );

    return job;
  }

  async updateIngestionJob(jobId: string, patch: Partial<IngestionJob>): Promise<IngestionJob> {
    const current = await this.getIngestionJob(jobId);
    if (!current) {
      throw new Error(`ingestion job '${jobId}' not found`);
    }

    const next: IngestionJob = { ...current, ...patch };
    await this.db.query(
      `update ingestion_jobs
       set status = $2,
           error = $3,
           started_at = $4,
           ended_at = $5
       where id = $1`,
      [next.id, next.status, next.error ?? null, next.started_at ?? null, next.ended_at ?? null]
    );

    return next;
  }

  async getIngestionJob(jobId: string): Promise<IngestionJob | undefined> {
    const result = await this.db.query<IngestionJob>(
      `select id, run_id, project_id, document_id, status, error,
              started_at::text as started_at,
              ended_at::text as ended_at
       from ingestion_jobs
       where id = $1 limit 1`,
      [jobId]
    );

    return result.rows[0];
  }

  async listIngestionJobs(projectId: string): Promise<IngestionJob[]> {
    const result = await this.db.query<IngestionJob>(
      `select id, run_id, project_id, document_id, status, error,
              started_at::text as started_at,
              ended_at::text as ended_at
       from ingestion_jobs
       where project_id = $1
       order by id asc`,
      [projectId]
    );

    return result.rows;
  }

  async createChat(chat: ChatRecord): Promise<ChatRecord> {
    await this.db.query(
      `insert into chats (id, project_id, title, created_at, updated_at)
       values ($1,$2,$3,$4,$5)
       on conflict (id) do update set title = excluded.title, updated_at = excluded.updated_at`,
      [chat.id, chat.project_id, chat.title, chat.created_at, chat.updated_at]
    );

    const existingMemory = await this.getChatMemory(chat.id);
    if (!existingMemory) {
      await this.updateChatMemory({
        chat_id: chat.id,
        rolling_summary: "",
        updated_at: chat.created_at
      });
    }

    return chat;
  }

  async getChat(chatId: string): Promise<ChatRecord | undefined> {
    const result = await this.db.query<ChatRecord>(
      `select id, project_id, title, created_at::text, updated_at::text
       from chats where id = $1 limit 1`,
      [chatId]
    );

    return result.rows[0];
  }

  async listProjectChats(projectId: string): Promise<ChatRecord[]> {
    const result = await this.db.query<ChatRecord>(
      `select id, project_id, title, created_at::text, updated_at::text
       from chats where project_id = $1
       order by updated_at desc`,
      [projectId]
    );

    return result.rows;
  }

  async addMessage(message: MessageRecord): Promise<MessageRecord> {
    await this.db.query(
      `insert into messages (id, chat_id, role, content, citations_json, model, token_usage_json, created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
      [
        message.id,
        message.chat_id,
        message.role,
        message.content,
        JSON.stringify(message.citations_json),
        message.model,
        JSON.stringify(message.token_usage_json),
        message.created_at
      ]
    );

    await this.db.query(`update chats set updated_at = $2 where id = $1`, [message.chat_id, message.created_at]);

    return message;
  }

  async listMessages(chatId: string): Promise<MessageRecord[]> {
    const result = await this.db.query<
      Omit<MessageRecord, "citations_json" | "token_usage_json"> & {
        citations_json: string | unknown[];
        token_usage_json: string | Record<string, number>;
      }
    >(
      `select m.id, m.chat_id, m.role, m.content, m.citations_json, m.model, m.token_usage_json, m.created_at::text,
              t.id as retrieval_trace_id
       from messages m
       left join retrieval_traces t on t.message_id = m.id
       where m.chat_id = $1
       order by m.created_at asc`,
      [chatId]
    );

    return result.rows.map((row) => ({
      ...row,
      citations_json: normalizeArray<Citation>(row.citations_json),
      token_usage_json: normalizeJson(row.token_usage_json) as Record<string, number>
    }));
  }

  async getMessage(chatId: string, messageId: string): Promise<MessageRecord | undefined> {
    const messages = await this.listMessages(chatId);
    return messages.find((message) => message.id === messageId);
  }

  async updateChatMemory(memory: ChatMemory): Promise<ChatMemory> {
    await this.db.query(
      `insert into chat_memory (chat_id, rolling_summary, last_summarized_message_id, updated_at)
       values ($1,$2,$3,$4)
       on conflict (chat_id) do update set
         rolling_summary = excluded.rolling_summary,
         last_summarized_message_id = excluded.last_summarized_message_id,
         updated_at = excluded.updated_at`,
      [
        memory.chat_id,
        memory.rolling_summary,
        memory.last_summarized_message_id ?? null,
        memory.updated_at
      ]
    );

    return memory;
  }

  async getChatMemory(chatId: string): Promise<ChatMemory | undefined> {
    const result = await this.db.query<ChatMemory>(
      `select chat_id, rolling_summary, last_summarized_message_id, updated_at::text
       from chat_memory where chat_id = $1 limit 1`,
      [chatId]
    );

    return result.rows[0];
  }

  async saveTrace(trace: RetrievalTrace): Promise<RetrievalTrace> {
    await this.db.query(
      `insert into retrieval_traces
       (id, project_id, chat_id, message_id, query, created_at,
        vector_candidates, bm25_candidates, fused_candidates, reranked_candidates, citations)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)
       on conflict (id) do update set
         message_id = excluded.message_id,
         reranked_candidates = excluded.reranked_candidates,
         citations = excluded.citations`,
      [
        trace.id,
        trace.project_id,
        trace.chat_id,
        trace.message_id,
        trace.query,
        trace.created_at,
        JSON.stringify(trace.vector_candidates),
        JSON.stringify(trace.bm25_candidates),
        JSON.stringify(trace.fused_candidates),
        JSON.stringify(trace.reranked_candidates),
        JSON.stringify(trace.citations)
      ]
    );

    return trace;
  }

  async getTrace(traceId: string): Promise<RetrievalTrace | undefined> {
    const result = await this.db.query<
      Omit<RetrievalTrace, "vector_candidates" | "bm25_candidates" | "fused_candidates" | "reranked_candidates" | "citations"> & {
        vector_candidates: string | unknown[];
        bm25_candidates: string | unknown[];
        fused_candidates: string | unknown[];
        reranked_candidates: string | unknown[];
        citations: string | unknown[];
      }
    >(
      `select id, project_id, chat_id, message_id, query, created_at::text,
              vector_candidates, bm25_candidates, fused_candidates, reranked_candidates, citations
       from retrieval_traces where id = $1 limit 1`,
      [traceId]
    );

    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    return {
      ...row,
      vector_candidates: normalizeArray<RetrievalCandidate>(row.vector_candidates),
      bm25_candidates: normalizeArray<RetrievalCandidate>(row.bm25_candidates),
      fused_candidates: normalizeArray<RetrievalCandidate>(row.fused_candidates),
      reranked_candidates: normalizeArray<RetrievalCandidate>(row.reranked_candidates),
      citations: normalizeArray<Citation>(row.citations)
    };
  }

  async createEvalSet(evalSet: EvalSet): Promise<EvalSet> {
    await this.db.query(
      `insert into eval_sets (id, name, query, expected_doc_ids_json, expected_facts_json)
       values ($1,$2,$3,$4::jsonb,$5::jsonb)
       on conflict (id) do update set name = excluded.name, query = excluded.query`,
      [
        evalSet.id,
        evalSet.name,
        evalSet.query,
        JSON.stringify(evalSet.expected_doc_ids_json),
        JSON.stringify(evalSet.expected_facts_json)
      ]
    );

    return evalSet;
  }

  async listEvalSets(): Promise<EvalSet[]> {
    const result = await this.db.query<
      Omit<EvalSet, "expected_doc_ids_json" | "expected_facts_json"> & {
        expected_doc_ids_json: string | string[];
        expected_facts_json: string | string[];
      }
    >(
      `select id, name, query, expected_doc_ids_json, expected_facts_json
       from eval_sets
       order by name asc`
    );

    return result.rows.map((row) => ({
      ...row,
      expected_doc_ids_json: normalizeArray(row.expected_doc_ids_json) as string[],
      expected_facts_json: normalizeArray(row.expected_facts_json) as string[]
    }));
  }

  async saveEvalRun(run: EvalRun): Promise<EvalRun> {
    await this.db.query(
      `insert into eval_runs (id, started_at, metrics_json, report_json)
       values ($1,$2,$3::jsonb,$4::jsonb)`,
      [run.id, run.started_at, JSON.stringify(run.metrics_json), JSON.stringify(run.report_json)]
    );

    return run;
  }

  async listEvalRuns(): Promise<EvalRun[]> {
    const result = await this.db.query<
      Omit<EvalRun, "metrics_json" | "report_json"> & {
        metrics_json: string | Record<string, number>;
        report_json: string | Array<Record<string, unknown>>;
      }
    >(
      `select id, started_at::text, metrics_json, report_json
       from eval_runs
       order by started_at desc`
    );

    return result.rows.map((row) => ({
      ...row,
      metrics_json: normalizeJson(row.metrics_json) as Record<string, number>,
      report_json: normalizeArray(row.report_json) as Array<Record<string, unknown>>
    }));
  }
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

async function insertChunk(client: PoolClient, chunk: ChunkRecord): Promise<void> {
  await client.query(
    `insert into chunks
      (id, project_id, document_id, chunk_index, content, token_count, embedding, metadata_json, tsvector_col)
     values
      ($1,$2,$3,$4,$5,$6,$7::vector,$8::jsonb,to_tsvector('english', $5))`,
    [
      chunk.id,
      chunk.project_id,
      chunk.document_id,
      chunk.chunk_index,
      chunk.content,
      chunk.token_count,
      toVectorLiteral(chunk.embedding),
      JSON.stringify(chunk.metadata_json)
    ]
  );
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }

  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeArray<T>(value: unknown): T[] {
  if (typeof value === "string") {
    return JSON.parse(value) as T[];
  }

  if (Array.isArray(value)) {
    return value as T[];
  }

  return [];
}

function parseVector(value: string | number[] | null): number[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/[\[\]\s]/g, "").trim();
    if (!normalized) {
      return [];
    }

    return normalized.split(",").map((chunk) => Number.parseFloat(chunk));
  }

  return [];
}
