import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/createApp.js";
import { buildContainer } from "../src/bootstrap.js";

const botProtection = {
  enabled: false,
  trustProxy: true,
  uploadMaxBytes: 20 * 1024 * 1024,
  rateLimits: {
    windowMs: 60_000,
    projectCreates: 15,
    chatCreates: 40,
    messages: 80,
    uploads: 20,
    evalRuns: 10
  }
};

describe("base path API routing", () => {
  it("mounts API endpoints under custom base path and keeps root health", async () => {
    const container = await buildContainer();
    const app = createApp({
      basePath: "/rag",
      botProtection,
      store: container.store,
      ragStore: container.ragStore,
      emitter: container.emitter,
      metrics: container.metrics,
      logger: container.logger,
      ingestionService: container.ingestionService,
      chatService: container.chatService,
      evalService: container.evalService
    });

    await request(app).get("/").expect(302).expect("Location", "/rag");
    await request(app).get("/health").expect(200, { ok: true });
    await request(app).get("/rag/health").expect(200, { ok: true });

    await request(app).post("/api/projects").send({ project_id: "outside-base" }).expect(404);

    const project = await request(app)
      .post("/rag/api/projects")
      .send({ project_id: "inside-base", name: "Inside Base" })
      .expect(201);

    expect(project.body.project_id).toBe("inside-base");

    const listing = await request(app).get("/rag/api/projects").expect(200);
    expect(Array.isArray(listing.body.projects)).toBe(true);
    expect(listing.body.projects.some((candidate: { id: string }) => candidate.id === "inside-base")).toBe(true);
  });

  it("normalizes base path values without leading slash", async () => {
    const container = await buildContainer();
    const app = createApp({
      basePath: "rag/",
      botProtection,
      store: container.store,
      ragStore: container.ragStore,
      emitter: container.emitter,
      metrics: container.metrics,
      logger: container.logger,
      ingestionService: container.ingestionService,
      chatService: container.chatService,
      evalService: container.evalService
    });

    await request(app).get("/").expect(302).expect("Location", "/rag");
    await request(app)
      .post("/rag/api/projects")
      .send({ project_id: "normalized-base", name: "Normalized Base" })
      .expect(201);
  });
});
