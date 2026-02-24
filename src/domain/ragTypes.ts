export type Project = {
  id: string;
  name: string;
  description?: string;
  created_at: string;
};

export type ParseStatus = "pending" | "parsed" | "failed";
export type OcrStatus = "pending" | "completed" | "skipped" | "failed";

export type DocumentRecord = {
  id: string;
  project_id: string;
  filename: string;
  mime_type: string;
  object_key: string;
  parse_status: ParseStatus;
  ocr_status: OcrStatus;
  created_at: string;
};

export type DocumentPart = {
  id: string;
  document_id: string;
  page_or_sheet: string;
  raw_text: string;
  metadata_json: Record<string, unknown>;
};

export type ChunkRecord = {
  id: string;
  project_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding: number[];
  metadata_json: Record<string, unknown>;
  tsvector_col: string;
};

export type IngestionJobStatus = "queued" | "in_progress" | "completed" | "failed";

export type IngestionJob = {
  id: string;
  run_id: string;
  project_id: string;
  document_id: string;
  status: IngestionJobStatus;
  error?: string;
  started_at?: string;
  ended_at?: string;
};

export type ChatRecord = {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type MessageRole = "user" | "assistant" | "system";

export type Citation = {
  document_id: string;
  chunk_id: string;
  preview: string;
  location?: string;
};

export type MessageRecord = {
  id: string;
  chat_id: string;
  role: MessageRole;
  content: string;
  citations_json: Citation[];
  model: string;
  token_usage_json: Record<string, number>;
  created_at: string;
  retrieval_trace_id?: string;
};

export type ChatMemory = {
  chat_id: string;
  rolling_summary: string;
  last_summarized_message_id?: string;
  updated_at: string;
};

export type RetrievalCandidate = {
  chunk_id: string;
  document_id: string;
  score: number;
  content: string;
};

export type RetrievalTrace = {
  id: string;
  project_id: string;
  chat_id: string;
  message_id: string;
  query: string;
  created_at: string;
  vector_candidates: RetrievalCandidate[];
  bm25_candidates: RetrievalCandidate[];
  fused_candidates: RetrievalCandidate[];
  reranked_candidates: RetrievalCandidate[];
  citations: Citation[];
};

export type EvalSet = {
  id: string;
  name: string;
  query: string;
  expected_doc_ids_json: string[];
  expected_facts_json: string[];
};

export type EvalRun = {
  id: string;
  started_at: string;
  metrics_json: Record<string, number>;
  report_json: Array<Record<string, unknown>>;
};
