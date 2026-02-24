# RAG Showcase Platform

Showcase RAG system with:
- multi-project isolation
- multi-chat isolation per project
- document ingestion (`PDF`, `MD`, `TXT`, `CSV`, `XLSX`)
- chunking + embeddings + hybrid retrieval + citations
- async guard rails with append-only run events and SSE replay
- ChatGPT-style Next.js + shadcn workspace UI (projects/chats/docs + live pipeline timeline)

## Runtime Modes
- `ADAPTER_MODE=memory`
  - in-memory stores, local files, deterministic embeddings/answers
  - best for fast local development/tests
- `ADAPTER_MODE=real`
  - Postgres/pgvector + Redis/BullMQ + MinIO + OpenAI
  - requires `OPENAI_API_KEY`

## Base Path
- `BASE_PATH=/` by default.
- Set `BASE_PATH=/rag` to mount UI and API under `/rag` (for example: `/rag`, `/rag/api/...`, `/rag/health`).
- Build-time assets and client fetch/EventSource URLs honor this value.

## Quick Start (Local Memory Mode)
```bash
npm install
npm test
npm run build
npm run dev
```

Open: `http://localhost:3000`

## Quick Start (Docker Real Mode)
1. Create env file:
```bash
cp .env.example .env
```
2. Set `OPENAI_API_KEY` in `.env`.
3. Start stack:
```bash
docker compose up -d --build
```
4. Open UI:
`http://localhost:3000`

Services:
- `web` (Express API + exported Next.js/shadcn UI)
- `worker` (BullMQ ingestion worker)
- `postgres` (`pgvector/pg16`)
- `redis`
- `minio`

## Async Guard Rails
- strict event envelope and schema versioning
- per-run monotonic `seq` + idempotency (`run_id`, `seq`)
- duplicate/out-of-order tolerance with projection replay
- terminal-state guarantees
- heartbeat + watchdog timeout synthesis
- run trace endpoint with transition validation

## Key Endpoints
- `POST /api/projects`
- `GET /api/projects`
- `POST /api/projects/:projectId/documents`
- `GET /api/projects/:projectId/documents`
- `POST /api/projects/:projectId/chats`
- `GET /api/projects/:projectId/chats`
- `GET /api/projects/:projectId/chats/:chatId/messages`
- `POST /api/projects/:projectId/chats/:chatId/messages`
- `GET /api/projects/:projectId/chats/:chatId/trace/:messageId`
- `GET /api/projects/:projectId/runs/:runId`
- `GET /api/projects/:projectId/runs/:runId/events` (SSE + `Last-Event-ID`)
- `GET /api/projects/:projectId/runs/:runId/trace`
- `POST /api/projects/:projectId/runs/:runId/heartbeat`
