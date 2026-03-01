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

describe("ingestion telemetry payloads", () => {
  it("emits detailed phase payloads for ingestion pipeline", async () => {
    const container = await buildContainer();
    const app = container.app;

    await request(app)
      .post("/api/projects")
      .send({ project_id: "p-ing-telemetry", name: "Ingestion Telemetry" })
      .expect(201);

    const contentBase64 = Buffer.from(
      "# Section One\nThis document is used to validate ingestion telemetry payload fields."
    ).toString("base64");

    const upload = await request(app)
      .post("/api/projects/p-ing-telemetry/documents")
      .send({ filename: "telemetry.md", mime_type: "text/markdown", content_base64: contentBase64 })
      .expect(202);

    const jobId = upload.body.ingestion_job.id as string;
    const runId = upload.body.ingestion_job.run_id as string;
    await waitForJobCompletion(app, "p-ing-telemetry", jobId);

    const traceResponse = await request(app).get(`/api/projects/p-ing-telemetry/runs/${runId}/trace`).expect(200);
    const events = traceResponse.body.events as Array<{ phase: string; payload: Record<string, unknown> }>;
    const byPhase = new Map(events.map((event) => [event.phase, event.payload]));

    const uploaded = byPhase.get("uploaded")!;
    expect(uploaded.filename).toBe("telemetry.md");
    expect(uploaded.mime_type).toBe("text/markdown");
    expect(Number(uploaded.file_size_bytes)).toBeGreaterThan(0);

    const parsed = byPhase.get("parsed")!;
    expect(parsed.parser_kind).toBe("markdown");
    expect(Number(parsed.parts)).toBeGreaterThan(0);
    expect(Number(parsed.raw_char_count)).toBeGreaterThan(0);
    expect(Number(parsed.raw_token_count)).toBeGreaterThan(0);

    const normalized = byPhase.get("normalized")!;
    expect(typeof normalized.reduction_pct).toBe("number");
    expect(Number(normalized.normalized_token_count)).toBeGreaterThan(0);

    const chunked = byPhase.get("chunked")!;
    const histogramBins = chunked.histogram_bins as Array<{ count: number }>;
    const histogramTotal = histogramBins.reduce((sum, bin) => sum + Number(bin.count), 0);
    expect(histogramTotal).toBe(Number(chunked.chunk_count));
    expect(Number(chunked.token_max)).toBeGreaterThanOrEqual(Number(chunked.token_min));

    const embedded = byPhase.get("embedded")!;
    expect(typeof embedded.embedding_model).toBe("string");
    expect(typeof embedded.embedding_provider).toBe("string");
    expect(typeof embedded.embedding_total_tokens).toBe("number");
    expect(typeof embedded.embedding_cost_usd).toBe("number");

    const completed = byPhase.get("completed")!;
    const summary = completed.summary as Record<string, unknown>;
    expect(summary.filename).toBe("telemetry.md");
    expect(typeof summary.duration_ms).toBe("number");
    expect(Number(summary.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(typeof summary.embedding_cost_usd).toBe("number");
  });
});
