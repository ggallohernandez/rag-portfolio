import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

async function waitForJobCompletion(
  app: Awaited<ReturnType<typeof buildContainer>>["app"],
  projectId: string,
  jobId: string
): Promise<void> {
  const timeoutAt = Date.now() + 4_000;

  while (Date.now() < timeoutAt) {
    const jobsResponse = await request(app).get(`/api/projects/${projectId}/jobs`).expect(200);
    const jobs = jobsResponse.body.jobs as Array<{ id: string; status: string }>;
    const job = jobs.find((candidate) => candidate.id === jobId);

    if (job?.status === "completed") {
      return;
    }

    if (job?.status === "failed") {
      throw new Error(`job '${jobId}' failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  throw new Error(`timed out waiting for job '${jobId}' completion`);
}

describe("query telemetry payloads", () => {
  it("emits embedding/context/answer telemetry fields", async () => {
    const container = await buildContainer();
    const app = container.app;

    await request(app)
      .post("/api/projects")
      .send({ project_id: "p-query-telemetry", name: "Query Telemetry" })
      .expect(201);

    const contentBase64 = Buffer.from(
      "The callback contract describes incubation terms and a revenue threshold."
    ).toString("base64");

    const upload = await request(app)
      .post("/api/projects/p-query-telemetry/documents")
      .send({ filename: "contract.txt", mime_type: "text/plain", content_base64: contentBase64 })
      .expect(202);

    await waitForJobCompletion(app, "p-query-telemetry", upload.body.ingestion_job.id as string);

    await request(app)
      .post("/api/projects/p-query-telemetry/chats")
      .send({ chat_id: "chat-telemetry", title: "Telemetry Chat" })
      .expect(201);

    const askResponse = await request(app)
      .post("/api/projects/p-query-telemetry/chats/chat-telemetry/messages")
      .send({ content: "What does the contract say about revenue?" })
      .expect(201);

    const runId = askResponse.body.runId as string;
    expect(typeof runId).toBe("string");

    const traceResponse = await request(app).get(`/api/projects/p-query-telemetry/runs/${runId}/trace`).expect(200);
    const events = traceResponse.body.events as Array<{ phase: string; payload: Record<string, unknown> }>;
    const byPhase = new Map(events.map((event) => [event.phase, event.payload]));

    const queryEmbedded = byPhase.get("query_embedded")!;
    expect(typeof queryEmbedded.embedding_model).toBe("string");
    expect(typeof queryEmbedded.embedding_total_tokens).toBe("number");
    expect(typeof queryEmbedded.embedding_cost_usd).toBe("number");
    expect(typeof queryEmbedded.token_source).toBe("string");

    const contextBuilt = byPhase.get("context_built")!;
    expect(typeof contextBuilt.context_preview).toBe("string");
    expect(typeof contextBuilt.context_full_redacted).toBe("string");
    expect(typeof contextBuilt.context_truncated).toBe("boolean");
    expect(typeof contextBuilt.context_redaction_applied).toBe("boolean");
    expect(Number(contextBuilt.recent_turns)).toBeGreaterThan(0);

    const answered = byPhase.get("answered")!;
    expect(typeof answered.answer_model).toBe("string");
    expect(typeof answered.answer_total_tokens).toBe("number");
    expect(typeof answered.answer_cost_usd).toBe("number");
    expect(typeof answered.query_embedding_cost_usd).toBe("number");
    expect(typeof answered.total_cost_usd).toBe("number");
    expect(typeof answered.answer_latency_ms).toBe("number");
    expect(Number(answered.answer_latency_ms)).toBeGreaterThanOrEqual(0);
  });
});
