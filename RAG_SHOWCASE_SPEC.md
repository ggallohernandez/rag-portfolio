## RAG Showcase Platform (Multi-Project, Multi-Chat, Animated Pipeline)

### Summary

Build a TypeScript full-stack showcase app that ingests mixed document types (including OCR paths), chunks and indexes content into `pgvector`, and answers with grounded citations.  
The app supports isolated projects (separate memory/corpus) and multiple chats per project (separate conversational memory with rolling summaries).  
A live technical visualizer streams ingestion and retrieval events via SSE to animate each pipeline stage in real time.

### Scope and Non-Goals

- In scope: single-user demo, Docker VM deployment, multi-format ingestion, hybrid retrieval + rerank, chunk-level citations, eval dashboard, live pipeline animations.
- Out of scope (v1): multi-user auth/roles, cross-project chats, enterprise access control, perfect OCR reliability guarantees.

### System Architecture

1. Web/API service: Next.js (App Router) with server endpoints for projects, chats, uploads, query/streaming, and eval UI.
2. Worker service: Node worker (BullMQ) processing ingestion jobs asynchronously and publishing stage events.
3. Data stores: Postgres with `pgvector` + full-text indexes, Redis for queue/events, MinIO for uploaded files.
4. External AI/parsing services: OpenAI (embeddings + answer/rerank flows), Unstructured API free plan for document partition/OCR when available.
5. Deployment: single `docker-compose` stack on one VM (`web`, `worker`, `postgres`, `redis`, `minio`).

### Public APIs, Interfaces, and Types

- `POST /api/projects`: create project.
- `GET /api/projects`: list projects.
- `POST /api/projects/:projectId/documents`: upload file and create ingestion job.
- `GET /api/projects/:projectId/jobs/:jobId/events` (SSE): ingestion stage events for animation.
- `POST /api/projects/:projectId/chats`: create chat thread.
- `GET /api/projects/:projectId/chats/:chatId/messages`: paginated message history.
- `POST /api/projects/:projectId/chats/:chatId/messages`: send user message and stream answer tokens + retrieval events.
- `GET /api/projects/:projectId/chats/:chatId/trace/:messageId`: retrieval trace and citation payload.
- `GET /api/evals` and `POST /api/evals/run`: read and execute evaluation suite.

Core event contract:

- `PipelineEvent`: `{ runId, projectId, chatId?, phase, status, progressPct, startedAt, endedAt?, meta }`.
- Ingestion phases: `uploaded`, `parsed`, `ocr`, `normalized`, `chunked`, `embedded`, `indexed`, `completed`, `failed`.
- Query phases: `query_received`, `query_embedded`, `retrieved_vector`, `retrieved_bm25`, `reranked`, `context_built`, `answer_streaming`, `answered`.

### Data Model

- `projects`: id, name, description, created_at.
- `documents`: id, project_id, filename, mime_type, object_key, parse_status, ocr_status, created_at.
- `document_parts`: id, document_id, page_or_sheet, raw_text, metadata_json.
- `chunks`: id, project_id, document_id, chunk_index, content, token_count, embedding(vector), metadata_json, tsvector_col.
- `ingestion_jobs`: id, project_id, document_id, status, error, started_at, ended_at.
- `chats`: id, project_id, title, created_at, updated_at.
- `messages`: id, chat_id, role, content, citations_json, model, token_usage_json, created_at.
- `chat_memory`: chat_id, rolling_summary, last_summarized_message_id, updated_at.
- `eval_sets`: id, name, query, expected_doc_ids_json, expected_facts_json.
- `eval_runs`: id, started_at, metrics_json, report_json.

Isolation rules:

- Every retrieval query must filter by `project_id`.
- Chat history is filtered by `chat_id` only.
- No cross-project retrieval in v1.

### Ingestion and Retrieval Design

1. Upload file to MinIO, create `documents` + `ingestion_jobs`.
2. Worker extracts text:

- Unstructured API first for partitioning/OCR-capable parsing.
- If Unstructured unavailable/quota hit: continue without OCR (mark `ocr_status='skipped'`, no blocking error).

1. Normalize text and metadata by file type:

- PDF/MD/TXT: section-aware chunking.
- CSV/XLSX: table-aware chunking (headers preserved in each chunk payload).

1. Chunking defaults:

- Target 500 tokens/chunk, 80 overlap, hard max 900.
- Keep section/page/sheet provenance in metadata.

1. Embeddings:

- Default `text-embedding-3-small` (balanced profile).

1. Hybrid retrieval:

- Vector top-k + Postgres full-text top-k.
- Fuse candidate sets (RRF).
- Rerank fused top-N with OpenAI scoring prompt.

1. Response generation:

- Build context pack from reranked chunks.
- Stream answer tokens.
- Attach chunk-level citations with source snippet and location metadata.

1. Long chat memory:

- Maintain rolling chat summary updated every N turns.
- Prompt uses summary + recent turns + retrieved chunks.

### Animation and UX Spec

- Use Framer Motion + SVG flow graph for an explicit technical pipeline view.
- Ingestion screen: animated node graph with stage transitions, durations, chunk counts, and embedding/index counts.
- Chat screen: retrieval timeline animation showing vector search, BM25 search, rerank, context assembly, and cited chunk mapping.
- Live state source: SSE events from jobs/query traces.
- Fallback UX: if event stream drops, auto-reconnect and resume by `runId`.
- Visual goal: technical credibility first (stateful, inspectable events), not decorative-only motion.

### Evaluation Dashboard

- Metrics: `Recall@K`, citation coverage rate, answer groundedness score, median latency, ingestion success rate by file type.
- Include seeded eval queries spanning PDF, markdown, and spreadsheet content.
- Show per-query trace with retrieved chunks and judge notes.

### Test Cases and Scenarios

1. Upload and ingest each type: PDF, MD, TXT, CSV, XLSX.
2. OCR pathway: scanned PDF with Unstructured available.
3. OCR disabled fallback: Unstructured failure/quota path continues ingest without OCR.
4. Project isolation: same keyword in two projects returns only active project chunks.
5. Chat isolation: two chats in one project do not leak message history.
6. Context-window handling: long conversation preserves intent via rolling summary.
7. Citation integrity: every answer includes valid chunk references and previews.
8. Retrieval quality: hybrid+rerank beats vector-only baseline on eval set.
9. SSE sequencing: phases emitted in valid order with terminal status.
10. Docker e2e: full stack boot, upload, ask, cite, and eval run pass.

### Acceptance Criteria

- User can create multiple projects and upload mixed files to each.
- User can open multiple chats per project and keep isolated conversational memory.
- Answers are grounded with chunk-level citations and snippet previews.
- Technical animation reflects real pipeline events for ingest and query flows.
- Entire app runs via Docker on one VM with persistent Postgres/MinIO volumes.
- Eval dashboard produces reproducible metrics from seeded test queries.

### Implementation Phases

1. Foundation: scaffold web/API, worker, Docker compose, DB schema, queue and storage wiring.
2. Ingestion pipeline: upload endpoints, file parsing adapters, chunker, embedding/index stages, ingestion SSE events.
3. Chat pipeline: chat/message APIs, hybrid retrieval + rerank, answer streaming, citation payloads, rolling summaries.
4. Animation UI: ingestion graph, retrieval timeline, trace inspector, reconnect behavior.
5. Evaluation: seed eval set, run pipeline, metrics UI and reports.
6. Hardening: retries, idempotent jobs, structured logs, latency/error instrumentation, final e2e tests.

### Assumptions and Defaults

- Single-user showcase with no auth in v1.
- OpenAI is the only LLM/embedding provider in v1.
- Unstructured free plan is used for parsing/OCR attempts.
- If Unstructured fails or quota is exceeded, OCR is skipped without blocking ingestion.
- Docker VM deployment is the primary target; no managed cloud-specific setup required.
- Default model profile is balanced quality/cost.

# RAG Showcase Spec Update: Async Testing Guard Rails

## Summary

Keep the previously agreed product scope (multi-format RAG, project/chat isolation, live pipeline animation), and add strict async guard rails so ingestion/query event flows are deterministic, testable, and debuggable under retries, duplicates, reordering, and disconnects.

## Public Interface Additions

- Event envelope for all ingestion/query stream events:
  - `{ event_id, run_id, project_id, chat_id?, phase, status, seq, emitted_at, correlation_id, causation_id?, schema_version, payload }`
- `GET /api/projects/:projectId/runs/:runId`
  - Returns authoritative run state, `last_seq`, terminal status, and phase timings.
- `GET /api/projects/:projectId/runs/:runId/events` (SSE)
  - Supports `Last-Event-ID` resume and server replay from persisted event log.
- `GET /api/projects/:projectId/runs/:runId/trace`
  - Returns normalized debug trace with transition validation results.

## Async Reliability Contract

- Explicit state machines for `IngestionRun` and `QueryRun`.
- Per-run sequence numbers are strictly increasing in canonical ordering.
- At-least-once delivery with idempotent consumers on `(run_id, seq)`.
- Out-of-order events are accepted and re-projected by `seq`.
- Exactly one terminal event (`completed|failed|cancelled`) per run.
- Timeout watchdog marks stale runs failed using a synthetic terminal event.
- `run_events` is append-only and used as replay source for SSE.

## Data Model Additions

- `run_events`
  - `event_id PK`, `run_id`, `seq`, `phase`, `status`, `payload_json`, `emitted_at`, unique `(run_id, seq)`.
- `run_state`
  - Materialized projection with `current_phase`, `status`, `last_seq`, `started_at`, `ended_at`, `error`.
- `run_heartbeats`
  - Worker heartbeat timestamps for stale-run detection.
- `dead_letter_jobs`
  - Failed jobs with retry metadata and error snapshots.

## Implementation Guard Rails

- Central transition validator module used by all emitters.
- Single event emitter utility applies schema validation and sequence assignment.
- Bounded exponential retries and dead-letter fallback.
- Reconciliation worker marks stale runs failed or resumes active runs.
- Animation completion is terminal-driven only (never progress-driven).

## Testing Guard Rails

1. Unit tests for full transition matrix.
2. Contract tests for event envelope schema and version compatibility.
3. Property-based tests for duplicates/reordering/gaps and projector invariants.
4. Integration tests for deterministic retry timing and watchdog timeout behavior.
5. SSE replay tests using `Last-Event-ID`.
6. Queue reliability tests for retries, crashes, and idempotent reprocessing.
7. End-to-end tests covering ingest -> query -> trace/citations.
8. Nightly chaos test for eventual consistency under random disorder.

## Observability and Debugging

- Correlated structured logs with `run_id`, `correlation_id`, and `seq`.
- Metrics:
  - `event_lag_ms`
  - `out_of_order_events_total`
  - `duplicate_events_total`
  - `run_timeout_total`
  - `replay_count`
  - `terminal_missing_total`
- Trace endpoint includes raw events, transition validation, and gap detection.

## Acceptance Criteria (Async)

- No invalid state transition can be persisted.
- Duplicate event injection does not change projected state.
- Out-of-order events converge correctly after replay.
- Every run has exactly one terminal event.
- SSE resume from any known event ID replays complete ordered history.
- Animation completion state matches backend projected terminal state.

## Assumptions and Defaults

- At-least-once delivery is acceptable.
- Idempotency is enforced at storage and projection layers.
- Event replay is retained for debugging/evaluation windows.
- Parser/OCR instability must remain observable and explicitly surfaced.

