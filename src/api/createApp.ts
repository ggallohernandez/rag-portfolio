import express, { NextFunction, Request, Response } from "express";
import multer from "multer";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { BotProtectionConfig } from "../config.js";
import { defaultStartPhase } from "../domain/stateMachine.js";
import { ChatRecord, DocumentRecord, MessageRecord, Project } from "../domain/ragTypes.js";
import { RunType } from "../domain/types.js";
import { ChatService } from "../services/chatService.js";
import { EvalService } from "../services/evalService.js";
import { EventEmitterService } from "../services/eventEmitter.js";
import { IngestionService } from "../services/ingestionService.js";
import { Logger } from "../services/logger.js";
import { MetricsRegistry } from "../services/metrics.js";
import { InMemoryRateLimiter } from "../services/rateLimiter.js";
import { IRunStore, IRagStore } from "../store/interfaces.js";

export type AppServices = {
  basePath?: string;
  botProtection: BotProtectionConfig;
  store: IRunStore;
  ragStore: IRagStore;
  emitter: EventEmitterService;
  metrics: MetricsRegistry;
  logger: Logger;
  ingestionService: IngestionService;
  chatService: ChatService;
  evalService: EvalService;
};

export function createApp(services: AppServices) {
  const app = express();
  const basePath = normalizeBasePath(services.basePath ?? "/");
  const publicDir = path.resolve(process.cwd(), "public");
  const router = express.Router();
  const botProtection = services.botProtection;
  const rateLimiter = new InMemoryRateLimiter();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: botProtection.uploadMaxBytes
    }
  });
  const uploadSingle = upload.single("file");

  app.use(express.json({ limit: "25mb" }));
  app.use(basePath, express.static(publicDir));
  if (botProtection.trustProxy) {
    app.set("trust proxy", true);
  }

  if (basePath !== "/") {
    app.get("/", (_request, response) => {
      response.redirect(basePath);
    });
  }

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  router.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  type BotRateTarget = "projectCreates" | "chatCreates" | "messages" | "uploads" | "evalRuns";

  const withBotGuard =
    (target: BotRateTarget) =>
    async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        if (await enforceBotGuard(request, response, target)) {
          next();
        }
      } catch (error) {
        next(error as Error);
      }
    };

  const withUploadSingle = (request: Request, response: Response, next: NextFunction): void => {
    uploadSingle(request, response, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        response.status(413).json({
          error: `file too large; max ${botProtection.uploadMaxBytes} bytes`
        });
        return;
      }

      next(error as Error);
    });
  };

  async function enforceBotGuard(
    request: Request,
    response: Response,
    target: BotRateTarget
  ): Promise<boolean> {
    if (!botProtection.enabled) {
      return true;
    }

    const clientIp = resolveClientIp(request, botProtection.trustProxy);
    const decision = rateLimiter.decide(`${target}:${clientIp}`, {
      windowMs: botProtection.rateLimits.windowMs,
      maxRequests: botProtection.rateLimits[target]
    });
    response.setHeader("X-RateLimit-Remaining", `${decision.remaining}`);

    if (!decision.allowed) {
      response.setHeader("Retry-After", `${decision.retryAfterSeconds}`);
      response.status(429).json({
        error: "rate limit exceeded, slow down and retry later"
      });
      return false;
    }

    return true;
  }

  router.post("/api/projects", withBotGuard("projectCreates"), async (request, response) => {
    const projectId =
      typeof request.body?.project_id === "string" && request.body.project_id.length > 0
        ? request.body.project_id
        : uuidv4();

    const project: Project = {
      id: projectId,
      name:
        typeof request.body?.name === "string" && request.body.name.length > 0
          ? request.body.name
          : `Project ${projectId.slice(0, 8)}`,
      description:
        typeof request.body?.description === "string" && request.body.description.length > 0
          ? request.body.description
          : undefined,
      created_at: new Date().toISOString()
    };

    await services.store.createProject(projectId);
    await services.ragStore.createProject(project);
    response.status(201).json({ ...project, project_id: project.id });
  });

  router.patch("/api/projects/:projectId", withBotGuard("projectCreates"), async (request, response) => {
    const projectId = request.params.projectId;
    const project = await services.ragStore.getProject(projectId);
    if (!project) {
      response.status(404).json({ error: `project '${projectId}' not found` });
      return;
    }

    const name = typeof request.body?.name === "string" ? request.body.name.trim() : undefined;

    let description: string | undefined;
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, "description")) {
      const value = request.body?.description;
      if (value === null) {
        description = undefined;
      } else if (typeof value === "string") {
        const trimmed = value.trim();
        description = trimmed.length > 0 ? trimmed : undefined;
      } else {
        response.status(400).json({ error: "description must be a string or null" });
        return;
      }
    }

    if (name !== undefined && name.length === 0) {
      response.status(400).json({ error: "name cannot be empty" });
      return;
    }

    if (name === undefined && description === undefined) {
      response.status(400).json({ error: "provide name or description to update" });
      return;
    }

    const updated = await services.ragStore.updateProject(projectId, {
      name,
      description
    });
    response.json(updated);
  });

  router.delete(
    "/api/projects/:projectId",
    withBotGuard("projectCreates"),
    async (request, response) => {
      const projectId = request.params.projectId;
      if (!(await services.ragStore.getProject(projectId))) {
        response.status(404).json({ error: `project '${projectId}' not found` });
        return;
      }

      await services.ragStore.deleteProject(projectId);
      response.status(204).send();
    }
  );

  router.get("/api/projects", async (_request, response) => {
    response.json({ projects: await services.ragStore.listProjects() });
  });

  router.post(
    "/api/projects/:projectId/documents",
    withBotGuard("uploads"),
    withUploadSingle,
    async (request, response) => {
    try {
      const projectId = request.params.projectId;
      const project = await services.ragStore.getProject(projectId);
      if (!project) {
        response.status(404).json({ error: `project '${projectId}' not found` });
        return;
      }

      const uploaded = request.file;
      const bodyFileName = typeof request.body?.filename === "string" ? request.body.filename : undefined;
      const bodyMimeType = typeof request.body?.mime_type === "string" ? request.body.mime_type : "text/plain";
      const bodyContentBase64 =
        typeof request.body?.content_base64 === "string" && request.body.content_base64.length > 0
          ? request.body.content_base64
          : undefined;

      const fileBuffer = uploaded
        ? uploaded.buffer
        : bodyContentBase64
          ? Buffer.from(bodyContentBase64, "base64")
          : undefined;

      const filename = uploaded?.originalname ?? bodyFileName ?? `document-${Date.now()}.txt`;
      const mimeType = uploaded?.mimetype ?? bodyMimeType;

      if (!fileBuffer || fileBuffer.length === 0) {
        response.status(400).json({
          error: "file upload is required. Provide multipart form-data with 'file' or content_base64 in JSON body."
        });
        return;
      }

      const documentId = uuidv4();
      const objectKey = `${projectId}/${documentId}/${filename}`;

      await services.ingestionService.storeObject(objectKey, fileBuffer);

      const document: DocumentRecord = {
        id: documentId,
        project_id: projectId,
        filename,
        mime_type: mimeType,
        object_key: objectKey,
        parse_status: "pending",
        ocr_status: "pending",
        created_at: new Date().toISOString()
      };

      await services.ragStore.createDocument(document);

      const job = await services.ingestionService.enqueueDocument(document.id, {
        filename,
        mimeType,
        fileSizeBytes: fileBuffer.length
      });

      response.status(202).json({
        document,
        ingestion_job: job
      });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
    }
  );

  router.get("/api/projects/:projectId/documents", async (request, response) => {
    const projectId = request.params.projectId;
    if (!(await services.ragStore.getProject(projectId))) {
      response.status(404).json({ error: `project '${projectId}' not found` });
      return;
    }

    response.json({ documents: await services.ragStore.listProjectDocuments(projectId) });
  });

  router.get("/api/projects/:projectId/jobs/:jobId/events", async (request, response) => {
    const { projectId, jobId } = request.params;
    const job = await services.ragStore.getIngestionJob(jobId);

    if (!job || job.project_id !== projectId) {
      response.status(404).json({ error: `job '${jobId}' not found for project '${projectId}'` });
      return;
    }

    await streamRunEvents(services, projectId, job.run_id, request, response);
  });

  router.get("/api/projects/:projectId/jobs", async (request, response) => {
    const projectId = request.params.projectId;
    if (!(await services.ragStore.getProject(projectId))) {
      response.status(404).json({ error: `project '${projectId}' not found` });
      return;
    }

    response.json({ jobs: await services.ragStore.listIngestionJobs(projectId) });
  });

  router.post("/api/projects/:projectId/chats", withBotGuard("chatCreates"), async (request, response) => {
    const projectId = request.params.projectId;
    if (!(await services.ragStore.getProject(projectId))) {
      response.status(404).json({ error: `project '${projectId}' not found` });
      return;
    }

    const chat: ChatRecord = {
      id: typeof request.body?.chat_id === "string" && request.body.chat_id.length > 0 ? request.body.chat_id : uuidv4(),
      project_id: projectId,
      title:
        typeof request.body?.title === "string" && request.body.title.length > 0
          ? request.body.title
          : `Chat ${new Date().toISOString()}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await services.ragStore.createChat(chat);
    response.status(201).json(chat);
  });

  router.patch(
    "/api/projects/:projectId/chats/:chatId",
    withBotGuard("chatCreates"),
    async (request, response) => {
      const { projectId, chatId } = request.params;
      const chat = await services.ragStore.getChat(chatId);
      if (!chat || chat.project_id !== projectId) {
        response.status(404).json({ error: `chat '${chatId}' not found in project '${projectId}'` });
        return;
      }

      const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
      if (title.length === 0) {
        response.status(400).json({ error: "title is required" });
        return;
      }

      const updated = await services.ragStore.updateChat(chatId, {
        title,
        updated_at: new Date().toISOString()
      });
      response.json(updated);
    }
  );

  router.delete(
    "/api/projects/:projectId/chats/:chatId",
    withBotGuard("chatCreates"),
    async (request, response) => {
      const { projectId, chatId } = request.params;
      const chat = await services.ragStore.getChat(chatId);
      if (!chat || chat.project_id !== projectId) {
        response.status(404).json({ error: `chat '${chatId}' not found in project '${projectId}'` });
        return;
      }

      await services.ragStore.deleteChat(chatId);
      response.status(204).send();
    }
  );

  router.get("/api/projects/:projectId/chats", async (request, response) => {
    const projectId = request.params.projectId;
    if (!(await services.ragStore.getProject(projectId))) {
      response.status(404).json({ error: `project '${projectId}' not found` });
      return;
    }

    response.json({ chats: await services.ragStore.listProjectChats(projectId) });
  });

  router.get("/api/projects/:projectId/chats/:chatId/messages", async (request, response) => {
    const { projectId, chatId } = request.params;
    const chat = await services.ragStore.getChat(chatId);
    if (!chat || chat.project_id !== projectId) {
      response.status(404).json({ error: `chat '${chatId}' not found in project '${projectId}'` });
      return;
    }

    const page = clampInt(request.query.page, 1);
    const limit = clampInt(request.query.limit, 20, 1, 100);
    const all = await services.ragStore.listMessages(chatId);

    const start = (page - 1) * limit;
    const messages = all.slice(start, start + limit);

    response.json({
      page,
      limit,
      total: all.length,
      messages
    });
  });

  router.post(
    "/api/projects/:projectId/chats/:chatId/messages",
    withBotGuard("messages"),
    async (request, response) => {
    const { projectId, chatId } = request.params;
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    const wantsStream =
      request.body?.stream === true || request.header("Accept")?.includes("text/event-stream") === true;

    if (content.length === 0) {
      response.status(400).json({ error: "content is required" });
      return;
    }

    try {
      const result = await services.chatService.ask(projectId, chatId, content);

      if (wantsStream) {
        setupSseHeaders(response);

        response.write("event: run_ref\n");
        response.write(`data: ${JSON.stringify({ run_id: result.runId })}\n\n`);

        const tokens = tokenizeAnswer(result.assistantMessage.content);
        for (const token of tokens) {
          response.write("event: token\n");
          response.write(`data: ${JSON.stringify({ token })}\n\n`);
        }

        for (const citation of result.assistantMessage.citations_json) {
          response.write("event: citation\n");
          response.write(`data: ${JSON.stringify(citation)}\n\n`);
        }

        response.write("event: done\n");
        response.write(
          `data: ${JSON.stringify({ message: result.assistantMessage, trace_id: result.trace.id, run_id: result.runId })}\n\n`
        );
        response.end();
        return;
      }

      response.status(201).json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
    }
  );

  router.get("/api/projects/:projectId/chats/:chatId/trace/:messageId", async (request, response) => {
    const { projectId, chatId, messageId } = request.params;
    const chat = await services.ragStore.getChat(chatId);

    if (!chat || chat.project_id !== projectId) {
      response.status(404).json({ error: `chat '${chatId}' not found in project '${projectId}'` });
      return;
    }

    const message = await services.ragStore.getMessage(chatId, messageId);
    if (!message) {
      response.status(404).json({ error: `message '${messageId}' not found in chat '${chatId}'` });
      return;
    }

    if (!message.retrieval_trace_id) {
      response.status(404).json({ error: `message '${messageId}' has no retrieval trace` });
      return;
    }

    const trace = await services.ragStore.getTrace(message.retrieval_trace_id);
    if (!trace) {
      response.status(404).json({ error: `trace '${message.retrieval_trace_id}' not found` });
      return;
    }

    response.json(trace);
  });

  router.get("/api/evals", async (_request, response) => {
    response.json({
      eval_sets: await services.ragStore.listEvalSets(),
      eval_runs: await services.ragStore.listEvalRuns()
    });
  });

  router.post("/api/evals/run", withBotGuard("evalRuns"), async (request, response) => {
    const projectId = typeof request.body?.project_id === "string" ? request.body.project_id : undefined;

    if (!projectId || !(await services.ragStore.getProject(projectId))) {
      response.status(400).json({ error: "valid project_id is required" });
      return;
    }

    const result = await services.evalService.run(projectId);
    response.status(201).json(result);
  });

  // Async guard-rail run endpoints.
  router.post("/api/projects/:projectId/runs", async (request, response) => {
    const projectId = request.params.projectId;
    const runType = request.body?.run_type as RunType | undefined;

    if (runType !== "ingestion" && runType !== "query") {
      response.status(400).json({ error: "run_type must be 'ingestion' or 'query'" });
      return;
    }

    if (!(await services.store.hasProject(projectId))) {
      response.status(404).json({ error: `project '${projectId}' not found` });
      return;
    }

    const runId =
      typeof request.body?.run_id === "string" && request.body.run_id.length > 0
        ? request.body.run_id
        : uuidv4();

    const chatId =
      typeof request.body?.chat_id === "string" && request.body.chat_id.length > 0
        ? request.body.chat_id
        : undefined;

    const correlationId =
      typeof request.body?.correlation_id === "string" && request.body.correlation_id.length > 0
        ? request.body.correlation_id
        : `run:${runId}`;

    await services.store.createRun({
      run_id: runId,
      project_id: projectId,
      run_type: runType,
      chat_id: chatId
    });

    await services.emitter.emit({
      run_id: runId,
      project_id: projectId,
      chat_id: chatId,
      phase: defaultStartPhase(runType),
      status: "started",
      correlation_id: correlationId,
      payload: {
        synthetic: false,
        origin: "run_created"
      }
    });

    const state = await services.store.getRunState(projectId, runId);
    response.status(201).json({ run_id: runId, state });
  });

  router.post("/api/projects/:projectId/runs/:runId/events", async (request, response) => {
    const projectId = request.params.projectId;
    const runId = request.params.runId;

    const run = await services.store.getRunRecord(runId);
    if (!run || run.project_id !== projectId) {
      response.status(404).json({ error: `run '${runId}' not found for project '${projectId}'` });
      return;
    }

    try {
      const event = await services.emitter.emit({
        run_id: runId,
        project_id: projectId,
        chat_id:
          typeof request.body?.chat_id === "string" && request.body.chat_id.length > 0
            ? request.body.chat_id
            : run.chat_id,
        phase: request.body?.phase,
        status: request.body?.status,
        correlation_id:
          typeof request.body?.correlation_id === "string" && request.body.correlation_id.length > 0
            ? request.body.correlation_id
            : `manual:${runId}`,
        causation_id:
          typeof request.body?.causation_id === "string" && request.body.causation_id.length > 0
            ? request.body.causation_id
            : undefined,
        payload: typeof request.body?.payload === "object" && request.body.payload ? request.body.payload : {},
        seq: typeof request.body?.seq === "number" ? request.body.seq : undefined,
        emitted_at:
          typeof request.body?.emitted_at === "string" && request.body.emitted_at.length > 0
            ? request.body.emitted_at
            : undefined,
        event_id:
          typeof request.body?.event_id === "string" && request.body.event_id.length > 0
            ? request.body.event_id
            : undefined
      });

      response.status(201).json(event);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/projects/:projectId/runs/:runId", async (request, response) => {
    const { projectId, runId } = request.params;
    const state = await services.store.getRunState(projectId, runId);
    if (!state) {
      response.status(404).json({ error: `run '${runId}' not found for project '${projectId}'` });
      return;
    }

    response.json(state);
  });

  router.get("/api/projects/:projectId/runs/:runId/trace", async (request, response) => {
    const { projectId, runId } = request.params;
    const trace = await services.store.getRunTrace(projectId, runId);
    if (!trace) {
      response.status(404).json({ error: `run '${runId}' not found for project '${projectId}'` });
      return;
    }

    response.json(trace);
  });

  router.post("/api/projects/:projectId/runs/:runId/heartbeat", async (request, response) => {
    const { projectId, runId } = request.params;
    const state = await services.store.getRunState(projectId, runId);
    if (!state) {
      response.status(404).json({ error: `run '${runId}' not found for project '${projectId}'` });
      return;
    }

    const value =
      typeof request.body?.heartbeat === "string" && request.body.heartbeat.length > 0
        ? request.body.heartbeat
        : new Date().toISOString();
    await services.store.setHeartbeat(runId, value);
    response.status(202).json({ run_id: runId, heartbeat: value });
  });

  router.get("/api/projects/:projectId/runs/:runId/events", async (request, response) => {
    const { projectId, runId } = request.params;
    await streamRunEvents(services, projectId, runId, request, response);
  });

  router.get("/api/metrics", (_request, response) => {
    response.json(services.metrics.snapshot());
  });

  router.get("/api/dead-letter-jobs", async (_request, response) => {
    response.json({ jobs: await services.store.listDeadLetterJobs() });
  });

  app.use(basePath, router);

  app.use((error: Error, _request: Request, response: Response, _next: () => void) => {
    services.logger.error("unhandled error", { error: error.message });
    response.status(500).json({ error: error.message });
  });

  return app;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/";
}

function resolveClientIp(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.header("x-forwarded-for");
    if (forwarded) {
      const first = forwarded
        .split(",")
        .map((value) => value.trim())
        .find((value) => value.length > 0);
      if (first) {
        return first;
      }
    }
  }

  return request.socket.remoteAddress ?? "unknown";
}

async function streamRunEvents(
  services: AppServices,
  projectId: string,
  runId: string,
  request: Request,
  response: Response
): Promise<void> {
  const state = await services.store.getRunState(projectId, runId);
  if (!state) {
    response.status(404).json({ error: `run '${runId}' not found for project '${projectId}'` });
    return;
  }

  setupSseHeaders(response);

  const lastEventIdHeader = request.header("Last-Event-ID");
  const resumeSeq = await resolveResumeSequence(services.store, runId, lastEventIdHeader);

  if (lastEventIdHeader) {
    services.metrics.increment("replay_count");
  }

  let lastSeqSent = resumeSeq;

  const historicalEvents = (await services.store.getRunEvents(projectId, runId))
    .filter((event) => event.seq > resumeSeq)
    .sort((a, b) => a.seq - b.seq);

  for (const event of historicalEvents) {
    writeSseEvent(response, "run_event", event);
    lastSeqSent = event.seq;
  }

  const unsubscribe = services.store.subscribeToRunEvents(runId, (event) => {
    writeSseEvent(response, "run_event", event);
    lastSeqSent = Math.max(lastSeqSent, event.seq);
  });

  // Cross-process fallback polling (worker events may be persisted from another process).
  const poll = setInterval(async () => {
    const events = await services.store.getRunEvents(projectId, runId);
    const unseen = events.filter((event) => event.seq > lastSeqSent).sort((a, b) => a.seq - b.seq);
    for (const event of unseen) {
      writeSseEvent(response, "run_event", event);
      lastSeqSent = event.seq;
    }
  }, 800);

  request.on("close", () => {
    clearInterval(poll);
    unsubscribe();
    response.end();
  });
}

function setupSseHeaders(response: Response): void {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

function writeSseEvent(response: Response, eventName: string, payload: Record<string, unknown>): void {
  response.write(`id: ${payload.event_id ?? uuidv4()}\n`);
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function resolveResumeSequence(
  store: IRunStore,
  runId: string,
  lastEventId: string | undefined
): Promise<number> {
  if (!lastEventId) {
    return 0;
  }

  const byId = await store.getEventById(runId, lastEventId);
  if (byId) {
    return byId.seq;
  }

  const asNumber = Number.parseInt(lastEventId, 10);
  return Number.isNaN(asNumber) ? 0 : Math.max(0, asNumber);
}

function clampInt(
  value: unknown,
  defaultValue: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return Math.max(min, Math.min(max, parsed));
    }
  }

  return defaultValue;
}

function tokenizeAnswer(content: string): string[] {
  return content.split(/(\s+)/).filter((token) => token.length > 0);
}

function _assertMessageType(_message: MessageRecord): void {
  // Keeps import for message type visible to compile-time checks.
}
