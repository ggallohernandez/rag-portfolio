export type AdapterMode = "memory" | "real";

export type AppConfig = {
  adapterMode: AdapterMode;
  basePath: string;
  postgresUrl: string;
  redisUrl: string;
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

  return {
    adapterMode,
    basePath,
    postgresUrl: process.env.POSTGRES_URL ?? "postgresql://rag:rag@postgres:5432/rag",
    redisUrl: process.env.REDIS_URL ?? "redis://redis:6379",
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

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");

  return withoutTrailingSlash.length === 0 ? "/" : withoutTrailingSlash;
}
