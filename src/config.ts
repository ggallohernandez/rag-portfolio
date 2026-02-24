export type AdapterMode = "memory" | "real";

export type BotProtectionConfig = {
  enabled: boolean;
  trustProxy: boolean;
  uploadMaxBytes: number;
  recaptchaSecretKey: string;
  recaptchaMinScore: number;
  rateLimits: {
    windowMs: number;
    projectCreates: number;
    chatCreates: number;
    messages: number;
    uploads: number;
    evalRuns: number;
  };
};

export type AppConfig = {
  adapterMode: AdapterMode;
  basePath: string;
  postgresUrl: string;
  redisUrl: string;
  botProtection: BotProtectionConfig;
  minio: {
    endPoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  openai: {
    apiKey: string;
    chatModel: string;
    embeddingModel: string;
  };
};

export function loadConfig(): AppConfig {
  const adapterMode = normalizeMode(process.env.ADAPTER_MODE ?? process.env.APP_MODE ?? "memory");
  const basePath = normalizeBasePath(process.env.BASE_PATH ?? "/");
  const botProtectionEnabled = toBool(process.env.BOT_PROTECTION_ENABLED ?? "false");
  const botRateLimitWindowMs = toInt(process.env.BOT_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 600_000);

  return {
    adapterMode,
    basePath,
    postgresUrl: process.env.POSTGRES_URL ?? "postgresql://rag:rag@postgres:5432/rag",
    redisUrl: process.env.REDIS_URL ?? "redis://redis:6379",
    botProtection: {
      enabled: botProtectionEnabled,
      trustProxy: toBool(process.env.BOT_TRUST_PROXY ?? "true"),
      uploadMaxBytes: toInt(process.env.BOT_UPLOAD_MAX_BYTES, 20 * 1024 * 1024, 1_048_576, 100 * 1024 * 1024),
      recaptchaSecretKey: process.env.RECAPTCHA_SECRET_KEY ?? "",
      recaptchaMinScore: toFloat(process.env.RECAPTCHA_MIN_SCORE, 0.5, 0, 1),
      rateLimits: {
        windowMs: botRateLimitWindowMs,
        projectCreates: toInt(process.env.BOT_PROJECT_CREATES_PER_WINDOW, 15, 1, 10_000),
        chatCreates: toInt(process.env.BOT_CHAT_CREATES_PER_WINDOW, 40, 1, 10_000),
        messages: toInt(process.env.BOT_MESSAGES_PER_WINDOW, 80, 1, 10_000),
        uploads: toInt(process.env.BOT_UPLOADS_PER_WINDOW, 20, 1, 10_000),
        evalRuns: toInt(process.env.BOT_EVAL_RUNS_PER_WINDOW, 10, 1, 10_000)
      }
    },
    minio: {
      endPoint: process.env.MINIO_ENDPOINT ?? "minio",
      port: Number.parseInt(process.env.MINIO_PORT ?? "9000", 10),
      useSSL: (process.env.MINIO_USE_SSL ?? "false").toLowerCase() === "true",
      accessKey: process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER ?? "minio",
      secretKey: process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "miniopassword",
      bucket: process.env.MINIO_BUCKET ?? "rag-documents"
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? "",
      chatModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small"
    }
  };
}

function normalizeMode(value: string): AdapterMode {
  return value.toLowerCase() === "real" ? "real" : "memory";
}

function toBool(value: string): boolean {
  return value.toLowerCase() === "true";
}

function toInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function toFloat(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(value ?? "");
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");

  return withoutTrailingSlash.length === 0 ? "/" : withoutTrailingSlash;
}
