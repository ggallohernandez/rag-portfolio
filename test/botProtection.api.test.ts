import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

const BOT_ENV_KEYS = [
  "BOT_PROTECTION_ENABLED",
  "BOT_TRUST_PROXY",
  "RECAPTCHA_SECRET_KEY",
  "RECAPTCHA_MIN_SCORE",
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

  it("rejects protected endpoint requests without captcha token", async () => {
    process.env.BOT_PROTECTION_ENABLED = "true";
    process.env.RECAPTCHA_SECRET_KEY = "secret";

    const container = await buildContainer();

    await request(container.app).post("/api/projects").send({ name: "No Token" }).expect(403);
  });

  it("accepts requests with valid captcha token", async () => {
    process.env.BOT_PROTECTION_ENABLED = "true";
    process.env.RECAPTCHA_SECRET_KEY = "secret";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          score: 0.9,
          action: "project_create"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const container = await buildContainer();

    const response = await request(container.app)
      .post("/api/projects")
      .set("X-Captcha-Token", "token")
      .send({ project_id: "bot-guard-ok", name: "Protected" })
      .expect(201);

    expect(response.body.project_id).toBe("bot-guard-ok");
  });
});
