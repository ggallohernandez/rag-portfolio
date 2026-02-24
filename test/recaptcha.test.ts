import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyRecaptchaToken } from "../src/services/recaptcha.js";

describe("verifyRecaptchaToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects low-score responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          score: 0.1,
          action: "chat_message"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const result = await verifyRecaptchaToken({
      token: "token",
      secretKey: "secret",
      expectedAction: "chat_message",
      minScore: 0.5
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_low_score");
  });

  it("accepts valid verification responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          score: 0.91,
          action: "document_upload"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const result = await verifyRecaptchaToken({
      token: "token",
      secretKey: "secret",
      expectedAction: "document_upload",
      minScore: 0.5
    });

    expect(result.ok).toBe(true);
    expect(result.score).toBe(0.91);
  });
});
