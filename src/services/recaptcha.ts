export type RecaptchaVerificationResult = {
  ok: boolean;
  reason?: string;
  score?: number;
  action?: string;
};

type RecaptchaApiResponse = {
  success?: boolean;
  score?: number;
  action?: string;
  ["error-codes"]?: string[];
};

export async function verifyRecaptchaToken(input: {
  token: string;
  secretKey: string;
  expectedAction: string;
  minScore: number;
  remoteIp?: string;
}): Promise<RecaptchaVerificationResult> {
  const params = new URLSearchParams();
  params.set("secret", input.secretKey);
  params.set("response", input.token);
  if (input.remoteIp) {
    params.set("remoteip", input.remoteIp);
  }

  let response: Response;
  try {
    response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
  } catch {
    return {
      ok: false,
      reason: "captcha_verify_unreachable"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `captcha_verify_http_${response.status}`
    };
  }

  let data: RecaptchaApiResponse;
  try {
    data = (await response.json()) as RecaptchaApiResponse;
  } catch {
    return {
      ok: false,
      reason: "captcha_verify_invalid_json"
    };
  }

  if (!data.success) {
    return {
      ok: false,
      reason: data["error-codes"]?.join(",") ?? "captcha_failed"
    };
  }

  if (typeof data.action === "string" && data.action.length > 0 && data.action !== input.expectedAction) {
    return {
      ok: false,
      reason: "captcha_action_mismatch",
      action: data.action,
      score: data.score
    };
  }

  if (typeof data.score === "number" && data.score < input.minScore) {
    return {
      ok: false,
      reason: "captcha_low_score",
      score: data.score,
      action: data.action
    };
  }

  return {
    ok: true,
    score: data.score,
    action: data.action
  };
}
