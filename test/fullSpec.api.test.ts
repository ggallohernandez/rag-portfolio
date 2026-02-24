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

describe("full spec API flows", () => {
  it("supports ingestion, isolation, chats, traces, and evals", async () => {
    const container = await buildContainer();
    const app = container.app;

    await request(app)
      .post("/api/projects")
      .send({ project_id: "p1", name: "Project One" })
      .expect(201);

    await request(app)
      .post("/api/projects")
      .send({ project_id: "p2", name: "Project Two" })
      .expect(201);

    const docOneBody = Buffer.from(
      "# Alpha Design\nRAG chunking stores alpha term and architecture decisions."
    ).toString("base64");

    const docTwoBody = Buffer.from(
      "# Beta Notes\nThis corpus discusses only beta concepts and unrelated operations."
    ).toString("base64");

    const uploadOne = await request(app)
      .post("/api/projects/p1/documents")
      .send({ filename: "alpha.md", mime_type: "text/markdown", content_base64: docOneBody })
      .expect(202);

    const uploadTwo = await request(app)
      .post("/api/projects/p2/documents")
      .send({ filename: "beta.md", mime_type: "text/markdown", content_base64: docTwoBody })
      .expect(202);

    const documentOneId = uploadOne.body.document.id as string;
    const documentTwoId = uploadTwo.body.document.id as string;

    await waitForJobCompletion(app, "p1", uploadOne.body.ingestion_job.id as string);
    await waitForJobCompletion(app, "p2", uploadTwo.body.ingestion_job.id as string);

    const chatOne = await request(app)
      .post("/api/projects/p1/chats")
      .send({ chat_id: "c1", title: "Primary" })
      .expect(201);

    const chatTwo = await request(app)
      .post("/api/projects/p1/chats")
      .send({ chat_id: "c2", title: "Secondary" })
      .expect(201);

    await request(app)
      .post("/api/projects/p2/chats")
      .send({ chat_id: "c3", title: "External" })
      .expect(201);

    expect(chatOne.body.project_id).toBe("p1");
    expect(chatTwo.body.project_id).toBe("p1");

    const answerOne = await request(app)
      .post("/api/projects/p1/chats/c1/messages")
      .send({ content: "Where is alpha term described?" })
      .expect(201);

    const answerTwo = await request(app)
      .post("/api/projects/p2/chats/c3/messages")
      .send({ content: "Where is alpha term described?" })
      .expect(201);

    const assistantOne = answerOne.body.assistantMessage;
    const assistantTwo = answerTwo.body.assistantMessage;

    expect(assistantOne.citations_json.length).toBeGreaterThan(0);
    expect(assistantOne.citations_json[0].document_id).toBe(documentOneId);

    const citedDocIdsTwo = new Set(
      (assistantTwo.citations_json as Array<{ document_id: string }>).map((citation) => citation.document_id)
    );
    expect(citedDocIdsTwo.has(documentOneId)).toBe(false);
    expect(citedDocIdsTwo.has(documentTwoId) || citedDocIdsTwo.size === 0).toBe(true);

    const trace = await request(app)
      .get(`/api/projects/p1/chats/c1/trace/${assistantOne.id as string}`)
      .expect(200);

    expect(trace.body.reranked_candidates.length).toBeGreaterThan(0);

    const messagesOne = await request(app).get("/api/projects/p1/chats/c1/messages").expect(200);
    const messagesTwo = await request(app).get("/api/projects/p1/chats/c2/messages").expect(200);

    expect(messagesOne.body.total).toBeGreaterThan(0);
    expect(messagesTwo.body.total).toBe(0);

    const evalRun = await request(app)
      .post("/api/evals/run")
      .send({ project_id: "p1" })
      .expect(201);

    expect(typeof evalRun.body.metrics.recall_at_k).toBe("number");
    expect(typeof evalRun.body.metrics.citation_coverage_rate).toBe("number");
  });
});
