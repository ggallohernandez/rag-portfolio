import path from "node:path";
import OpenAI from "openai";
import { createApp } from "./api/createApp.js";
import { BullMQQueueAdapter } from "./adapters/queue/bullmqQueue.js";
import { OpenAIAnswerService } from "./adapters/openai/openaiAnswerService.js";
import { OpenAIEmbeddingService } from "./adapters/openai/openaiEmbeddingService.js";
import { OpenAIRetrievalService } from "./adapters/openai/openaiRetrievalService.js";
import { PostgresClient } from "./adapters/postgres/postgresClient.js";
import { PostgresRagStore } from "./adapters/postgres/postgresRagStore.js";
import { PostgresRetrievalService } from "./adapters/postgres/postgresRetrievalService.js";
import { PostgresRunStore } from "./adapters/postgres/postgresRunStore.js";
import { loadConfig } from "./config.js";
import { InMemoryQueue } from "./queue/inMemoryQueue.js";
import { AnswerService } from "./services/answerService.js";
import { ChatService } from "./services/chatService.js";
import { ChatMemoryService } from "./services/chatMemoryService.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { EvalService } from "./services/evalService.js";
import { EventEmitterService } from "./services/eventEmitter.js";
import { IngestionService, QueueLike, asInlineQueue } from "./services/ingestionService.js";
import { Logger } from "./services/logger.js";
import { MetricsRegistry } from "./services/metrics.js";
import { LocalObjectStorage, MinioObjectStorage, ObjectStorage } from "./services/objectStorage.js";
import { ReconciliationWorker } from "./services/reconciler.js";
import { RetrievalService } from "./services/retrievalService.js";
import { RetryPolicyConfig } from "./services/retryPolicy.js";
import { RunWatchdog } from "./services/watchdog.js";
import { RagStore } from "./store/ragStore.js";
import { RunStore } from "./store/runStore.js";
import { IRagStore, IRunStore } from "./store/interfaces.js";
import type { EmbeddingGenerator } from "./services/contracts.js";

export type AppContainer = {
  app: ReturnType<typeof createApp>;
  store: IRunStore;
  ragStore: IRagStore;
  emitter: EventEmitterService;
  watchdog: RunWatchdog;
  reconciler: ReconciliationWorker;
  queue: InMemoryQueue | BullMQQueueAdapter;
  metrics: MetricsRegistry;
  logger: Logger;
  objectStorage: ObjectStorage;
  ingestionService: IngestionService;
  chatService: ChatService;
  evalService: EvalService;
  config: ReturnType<typeof loadConfig>;
  pg?: PostgresClient;
  bullQueue?: BullMQQueueAdapter;
};

export async function buildContainer(now: () => number = () => Date.now()): Promise<AppContainer> {
  const config = loadConfig();
  const logger = new Logger();
  const metrics = new MetricsRegistry();
  const shouldRunMigrations = (process.env.RUN_MIGRATIONS ?? "true").toLowerCase() !== "false";

  let store: IRunStore;
  let ragStore: IRagStore;
  let queue: InMemoryQueue | BullMQQueueAdapter;
  let queueLike: QueueLike;
  let objectStorage: ObjectStorage;
  let pg: PostgresClient | undefined;
  let bullQueue: BullMQQueueAdapter | undefined;

  const retryPolicy: RetryPolicyConfig = {
    maxAttempts: 3,
    baseDelayMs: 50,
    maxDelayMs: 500
  };

  if (config.adapterMode === "real") {
    pg = new PostgresClient(config.postgresUrl);
    if (shouldRunMigrations) {
      await pg.ensureSchema();
    }

    store = new PostgresRunStore(pg, metrics);
    ragStore = new PostgresRagStore(pg);

    const queueAdapter = new BullMQQueueAdapter(config.redisUrl, logger);
    bullQueue = queueAdapter;
    queue = queueAdapter;
    queueLike = {
      mode: "external",
      enqueue: (runId, payload) => queueAdapter.enqueue(runId, payload)
    };

    objectStorage = new MinioObjectStorage(config.minio);
  } else {
    store = new RunStore(metrics);
    ragStore = new RagStore();
    queue = new InMemoryQueue(store, logger, retryPolicy);
    queueLike = asInlineQueue(queue);
    objectStorage = new LocalObjectStorage(path.resolve(process.cwd(), "data", "objects"));
  }

  let embeddingService: EmbeddingGenerator;
  let retrievalService: RetrievalService | OpenAIRetrievalService;
  let answerService: AnswerService | OpenAIAnswerService;

  if (config.adapterMode === "real") {
    if (!config.openai.apiKey) {
      throw new Error("OPENAI_API_KEY is required when ADAPTER_MODE=real");
    }

    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    const openAIEmbeddingService = new OpenAIEmbeddingService(openai, config.openai.embeddingModel);
    embeddingService = openAIEmbeddingService;

    const pgRetriever = new PostgresRetrievalService(pg as PostgresClient);
    retrievalService = new OpenAIRetrievalService(pgRetriever, openAIEmbeddingService);
    answerService = new OpenAIAnswerService(openai, config.openai.chatModel);
  } else {
    const deterministicEmbedding = new EmbeddingService();
    embeddingService = deterministicEmbedding;
    retrievalService = new RetrievalService(ragStore, deterministicEmbedding);
    answerService = new AnswerService();
  }

  const emitter = new EventEmitterService(store, logger);
  const memoryService = new ChatMemoryService(ragStore);

  const ingestionService = new IngestionService(
    ragStore,
    store,
    queueLike,
    emitter,
    embeddingService,
    objectStorage,
    logger,
    {
      embeddingUsdPer1MTokens: config.openai.embeddingUsdPer1MTokens
    }
  );

  const chatService = new ChatService(ragStore, store, emitter, retrievalService, answerService, memoryService, {
    embeddingUsdPer1MTokens: config.openai.embeddingUsdPer1MTokens,
    chatInputUsdPer1MTokens: config.openai.chatInputUsdPer1MTokens,
    chatOutputUsdPer1MTokens: config.openai.chatOutputUsdPer1MTokens,
    contextMaxChars: config.pipeline.contextMaxChars,
    contextRedactionEnabled: config.pipeline.contextRedactionEnabled
  });

  const evalService = new EvalService(ragStore, retrievalService, answerService);
  await evalService.seedDefaults();

  const watchdog = new RunWatchdog(store, emitter, metrics, logger, {
    staleThresholdMs: 60_000,
    now
  });

  const reconciler = new ReconciliationWorker(store, emitter, logger, metrics, {
    staleThresholdMs: 120_000,
    now
  });

  const app = createApp({
    basePath: config.basePath,
    botProtection: config.botProtection,
    store,
    ragStore,
    emitter,
    logger,
    metrics,
    ingestionService,
    chatService,
    evalService
  });

  return {
    app,
    store,
    ragStore,
    emitter,
    watchdog,
    reconciler,
    queue,
    metrics,
    logger,
    objectStorage,
    ingestionService,
    chatService,
    evalService,
    config,
    pg,
    bullQueue
  };
}
