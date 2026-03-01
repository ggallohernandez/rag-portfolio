import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

describe("end-to-end async pipeline", () => {
  it("supports ingest to query trace with citations", async () => {
    const container = await buildContainer();
    const app = container.app;

    const projectResponse = await request(app)
      .post("/api/projects")
      .send({ project_id: "project-e2e" })
      .expect(201);

    const projectId = projectResponse.body.project_id as string;

    const ingestionResponse = await request(app)
      .post(`/api/projects/${projectId}/runs`)
      .send({ run_id: "ingestion-1", run_type: "ingestion", correlation_id: "ingest-corr" })
      .expect(201);

    expect(ingestionResponse.body.state.last_seq).toBe(1);

    const ingestionEvents = [
      { seq: 2, phase: "parsed", status: "in_progress" },
      { seq: 3, phase: "normalized", status: "in_progress" },
      { seq: 4, phase: "chunked", status: "in_progress" },
      { seq: 5, phase: "embedded", status: "in_progress" },
      { seq: 6, phase: "indexed", status: "in_progress" },
      { seq: 7, phase: "completed", status: "completed" }
    ];

    for (const event of ingestionEvents) {
      await request(app)
        .post(`/api/projects/${projectId}/runs/ingestion-1/events`)
        .send({
          ...event,
          correlation_id: "ingest-corr",
          payload: { stage: event.phase }
        })
        .expect(201);
    }

    const queryResponse = await request(app)
      .post(`/api/projects/${projectId}/runs`)
      .send({ run_id: "query-1", run_type: "query", chat_id: "chat-1", correlation_id: "query-corr" })
      .expect(201);

    expect(queryResponse.body.state.current_phase).toBe("query_received");

    const queryEvents = [
      {
        seq: 2,
        phase: "query_embedded",
        status: "in_progress",
        payload: {
          embedding_model: "text-embedding-3-small",
          embedding_total_tokens: 42,
          embedding_cost_usd: 0.000002
        }
      },
      { seq: 3, phase: "retrieved_vector", status: "in_progress" },
      { seq: 4, phase: "retrieved_bm25", status: "in_progress" },
      { seq: 5, phase: "reranked", status: "in_progress" },
      { seq: 6, phase: "context_built", status: "in_progress" },
      { seq: 7, phase: "answer_streaming", status: "in_progress" },
      {
        seq: 8,
        phase: "answered",
        status: "completed",
        payload: {
          answer: "The chunker uses 500 token windows.",
          answer_total_tokens: 120,
          total_cost_usd: 0.0004,
          citations: [
            {
              document_id: "doc-1",
              chunk_id: "chunk-12",
              preview: "Chunk size defaults to 500 tokens with overlap."
            }
          ]
        }
      }
    ];

    for (const event of queryEvents) {
      await request(app)
        .post(`/api/projects/${projectId}/runs/query-1/events`)
        .send({
          ...event,
          correlation_id: "query-corr"
        })
        .expect(201);
    }

    const stateResponse = await request(app)
      .get(`/api/projects/${projectId}/runs/query-1`)
      .expect(200);

    expect(stateResponse.body.status).toBe("completed");
    expect(stateResponse.body.last_seq).toBe(8);

    const traceResponse = await request(app)
      .get(`/api/projects/${projectId}/runs/query-1/trace`)
      .expect(200);

    expect(traceResponse.body.has_terminal).toBe(true);
    expect(traceResponse.body.terminal_count).toBe(1);

    const lastEvent = traceResponse.body.events.at(-1);
    expect(lastEvent.payload.citations).toHaveLength(1);
    expect(lastEvent.payload.citations[0].chunk_id).toBe("chunk-12");
    expect(lastEvent.payload.answer_total_tokens).toBe(120);
    expect(lastEvent.payload.total_cost_usd).toBe(0.0004);

    const invalidTransitions = traceResponse.body.transitions.filter(
      (transition: { valid: boolean }) => !transition.valid
    );
    expect(invalidTransitions).toHaveLength(0);
  });
});
