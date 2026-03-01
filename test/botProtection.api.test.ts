import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

const BOT_ENV_KEYS = [
  "BOT_PROTECTION_ENABLED",
  "BOT_TRUST_PROXY",
  "BOT_RATE_LIMIT_WINDOW_MS",
  "BOT_PROJECT_CREATES_PER_WINDOW",
  "BOT_CHAT_CREATES_PER_WINDOW",
  "BOT_MESSAGES_PER_WINDOW",
  "BOT_UPLOADS_PER_WINDOW",
  "BOT_EVAL_RUNS_PER_WINDOW"
] as const;

describe("bot protection API guard", () => {
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of BOT_ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of BOT_ENV_KEYS) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("accepts protected endpoint requests without captcha token", async () => {
    process.env.BOT_PROTECTION_ENABLED = "true";

    const container = await buildContainer();

    await request(container.app).post("/api/projects").send({ name: "No Token" }).expect(201);
  });

  it("enforces project-create rate limits when protection is enabled", async () => {
    process.env.BOT_PROTECTION_ENABLED = "true";
    process.env.BOT_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.BOT_PROJECT_CREATES_PER_WINDOW = "1";

    const container = await buildContainer();

    const first = await request(container.app)
      .post("/api/projects")
      .send({ project_id: "bot-guard-ok-1", name: "Protected 1" })
      .expect(201);

    expect(first.body.project_id).toBe("bot-guard-ok-1");

    await request(container.app)
      .post("/api/projects")
      .send({ project_id: "bot-guard-ok-2", name: "Protected 2" })
      .expect(429);
  });
});
