CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  ocr_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_parts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  page_or_sheet TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  token_count INT NOT NULL,
  embedding vector,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  tsvector_col tsvector
);
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector;

CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks(project_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN(tsvector_col);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  status TEXT NOT NULL,
  error TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT NOT NULL,
  token_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_memory (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id),
  rolling_summary TEXT NOT NULL,
  last_summarized_message_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eval_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  expected_doc_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_facts_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  metrics_json JSONB NOT NULL,
  report_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  chat_id TEXT,
  seq INT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  schema_version INT NOT NULL DEFAULT 1,
  payload_json JSONB NOT NULL,
  emitted_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, seq)
);
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS chat_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS causation_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS schema_version INT DEFAULT 1;
ALTER TABLE run_events ALTER COLUMN schema_version DROP DEFAULT;
ALTER TABLE run_events ALTER COLUMN schema_version TYPE INT USING schema_version::numeric::int;
ALTER TABLE run_events ALTER COLUMN schema_version SET DEFAULT 1;
UPDATE run_events SET schema_version = 1 WHERE schema_version IS NULL;
CREATE INDEX IF NOT EXISTS run_events_run_seq_idx ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS run_state (
  run_id TEXT PRIMARY KEY,
  current_phase TEXT,
  status TEXT NOT NULL,
  last_seq INT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  error TEXT,
  phase_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  invalid_transition_count INT NOT NULL DEFAULT 0,
  gap_count INT NOT NULL DEFAULT 0,
  terminal_event_id TEXT
);
ALTER TABLE run_state ADD COLUMN IF NOT EXISTS phase_timings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE run_state ADD COLUMN IF NOT EXISTS invalid_transition_count INT NOT NULL DEFAULT 0;
ALTER TABLE run_state ADD COLUMN IF NOT EXISTS gap_count INT NOT NULL DEFAULT 0;
ALTER TABLE run_state ADD COLUMN IF NOT EXISTS terminal_event_id TEXT;
CREATE INDEX IF NOT EXISTS run_state_status_idx ON run_state(status);

CREATE TABLE IF NOT EXISTS run_projects (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES run_projects(id),
  run_type TEXT NOT NULL,
  chat_id TEXT
);
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id);

CREATE TABLE IF NOT EXISTS run_heartbeats (
  run_id TEXT PRIMARY KEY,
  heartbeat_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_traces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  chat_id TEXT NOT NULL REFERENCES chats(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  query TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vector_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  bm25_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  fused_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  reranked_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS retrieval_traces_project_chat_idx ON retrieval_traces(project_id, chat_id, created_at DESC);
