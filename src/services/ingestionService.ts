import { v4 as uuidv4 } from "uuid";
import { defaultStartPhase } from "../domain/stateMachine.js";
import { IngestionJob } from "../domain/ragTypes.js";
import { IngestionPhase } from "../domain/types.js";
import { EventEmitterService } from "./eventEmitter.js";
import { Logger } from "./logger.js";
import { parseDocument } from "./documentParser.js";
import { chunkDocumentParts, normalizeForSearch, tokenize } from "./chunker.js";
import { IRagStore, IRunStore } from "../store/interfaces.js";
import { ObjectStorage } from "./objectStorage.js";
import { InMemoryQueue } from "../queue/inMemoryQueue.js";
import type { EmbeddingGenerator } from "./contracts.js";
import { embeddingCostUsd } from "./costing.js";
import { summarizeChunkTokens } from "./telemetry.js";

export type QueueLike = {
  mode: "inline" | "external";
  enqueue(runId: string, payload: Record<string, unknown>): unknown | Promise<unknown>;
  pendingJobs?: () => number;
  drainWithDeadLetter?: (
    handler: (job: { id: string; run_id: string; payload: Record<string, unknown> }) => Promise<void>,
    onDeadLetter?: (job: { id: string; run_id: string; payload: Record<string, unknown> }, error: Error, attempts: number) => Promise<void> | void
  ) => Promise<void>;
};

export class IngestionService {
  private draining = false;

  constructor(
    private readonly ragStore: IRagStore,
    private readonly runStore: IRunStore,
    private readonly queue: QueueLike,
    private readonly emitter: EventEmitterService,
    private readonly embeddingService: EmbeddingGenerator,
    private readonly objectStorage: ObjectStorage,
    private readonly logger: Logger,
    private readonly telemetryConfig: {
      embeddingUsdPer1MTokens: number;
    }
  ) {}

  async enqueueDocument(
    documentId: string,
    options: {
      filename?: string;
      mimeType?: string;
      fileSizeBytes?: number;
    } = {}
  ): Promise<IngestionJob> {
    const document = await this.ragStore.getDocument(documentId);
    if (!document) {
      throw new Error(`document '${documentId}' not found`);
    }

    const job: IngestionJob = {
      id: uuidv4(),
      run_id: uuidv4(),
      project_id: document.project_id,
      document_id: document.id,
      status: "queued"
    };

    await this.ragStore.createIngestionJob(job);

    await this.runStore.createRun({
      run_id: job.run_id,
      project_id: job.project_id,
      run_type: "ingestion"
    });

    await this.emitter.emit({
      run_id: job.run_id,
      project_id: job.project_id,
      phase: defaultStartPhase("ingestion"),
      status: "started",
      correlation_id: `job:${job.id}`,
      payload: {
        job_id: job.id,
        document_id: job.document_id,
        filename: options.filename ?? document.filename,
        mime_type: options.mimeType ?? document.mime_type,
        file_size_bytes: options.fileSizeBytes ?? 0
      }
    });

    await this.queue.enqueue(job.run_id, {
      kind: "ingestion",
      job_id: job.id
    });

    if (this.queue.mode === "inline") {
      void this.processQueue();
    }

    return job;
  }

  async storeObject(objectKey: string, body: Buffer): Promise<void> {
    await this.objectStorage.putObject(objectKey, body);
  }

  async waitForIdle(): Promise<void> {
    const getPendingJobs = this.queue.pendingJobs;

    while (this.draining || (typeof getPendingJobs === "function" && getPendingJobs() > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async processJobById(jobId: string): Promise<void> {
    await this.runIngestion(jobId);
  }

  async handlePermanentFailure(
    jobId: string,
    error: Error,
    attempts: number,
    payload: Record<string, unknown> = {
      kind: "ingestion",
      job_id: jobId
    }
  ): Promise<void> {
    const ingestionJob = await this.ragStore.getIngestionJob(jobId);
    if (!ingestionJob) {
      return;
    }

    await this.ragStore.updateIngestionJob(ingestionJob.id, {
      status: "failed",
      error: error.message,
      ended_at: new Date().toISOString()
    });

    await this.ragStore.updateDocument(ingestionJob.document_id, {
      parse_status: "failed"
    });

    await this.runStore.addDeadLetterJob({
      job_id: ingestionJob.id,
      run_id: ingestionJob.run_id,
      reason: error.message,
      attempts,
      failed_at: new Date().toISOString(),
      payload
    });

    try {
      await this.emitter.emit({
        run_id: ingestionJob.run_id,
        project_id: ingestionJob.project_id,
        phase: "failed",
        status: "failed",
        correlation_id: `job:${ingestionJob.id}`,
        payload: {
          job_id: ingestionJob.id,
          error: error.message
        }
      });
    } catch (emitError) {
      this.logger.error("failed to emit ingestion failure", {
        job_id: ingestionJob.id,
        error: emitError instanceof Error ? emitError.message : String(emitError)
      });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.draining || !this.queue.drainWithDeadLetter) {
      return;
    }

    this.draining = true;
    await this.queue.drainWithDeadLetter(
      async (job) => {
        const payload = job.payload;
        if (payload.kind !== "ingestion" || typeof payload.job_id !== "string") {
          return;
        }

        await this.runIngestion(payload.job_id);
      },
      async (job, error, attempts) => {
        const payload = job.payload;
        if (payload.kind !== "ingestion" || typeof payload.job_id !== "string") {
          return;
        }

        await this.handlePermanentFailure(payload.job_id, error, attempts, payload);
      }
    );

    this.draining = false;
  }

  private async runIngestion(jobId: string): Promise<void> {
    const job = await this.ragStore.getIngestionJob(jobId);
    if (!job) {
      throw new Error(`ingestion job '${jobId}' not found`);
    }

    const runState = await this.runStore.getRunState(job.project_id, job.run_id);
    if (runState && (runState.status === "completed" || runState.status === "failed" || runState.status === "cancelled")) {
      this.logger.info("skipping ingestion for terminal run", {
        run_id: job.run_id,
        status: runState.status
      });
      return;
    }

    let phaseCursor = asIngestionPhase(runState?.current_phase);
    const emitProgress = async (phase: IngestionPhase, payload: Record<string, unknown>): Promise<void> => {
      if (!shouldEmitIngestionPhase(phaseCursor, phase)) {
        return;
      }

      await this.emitter.emit({
        run_id: job.run_id,
        project_id: job.project_id,
        phase,
        status: phase === "completed" ? "completed" : "in_progress",
        correlation_id: `job:${job.id}`,
        payload
      });
      phaseCursor = phase;
    };

    const document = await this.ragStore.getDocument(job.document_id);
    if (!document) {
      throw new Error(`document '${job.document_id}' not found`);
    }

    const runStartedMs = Date.now();
    await this.ragStore.updateIngestionJob(job.id, {
      status: "in_progress",
      started_at: new Date().toISOString()
    });

    const buffer = await this.objectStorage.getObject(document.object_key);
    const parsed = await parseDocument(document.id, document.filename, document.mime_type, buffer);
    const parsedText = parsed.parts.map((part) => part.raw_text).join("\n");
    const rawCharCount = parsedText.length;
    const rawTokenCount = tokenize(parsedText).length;

    await emitProgress("parsed", {
      job_id: job.id,
      parts: parsed.parts.length,
      parser_kind: parsed.parser_kind,
      mime_type: document.mime_type,
      raw_char_count: rawCharCount,
      raw_token_count: rawTokenCount
    });

    if (parsed.ocr_status === "completed") {
      await emitProgress("ocr", {
        job_id: job.id
      });
    }

    const normalizedText = normalizeForSearch(parsedText);
    const normalizedCharCount = normalizedText.length;
    const normalizedTokenCount = tokenize(normalizedText).length;
    const reductionPct =
      rawCharCount <= 0 ? 0 : Math.round(((rawCharCount - normalizedCharCount) / Math.max(1, rawCharCount)) * 10_000) / 100;

    await emitProgress("normalized", {
      job_id: job.id,
      normalized_char_count: normalizedCharCount,
      normalized_token_count: normalizedTokenCount,
      reduction_pct: reductionPct
    });

    const chunks = chunkDocumentParts(document.project_id, document.id, parsed.parts);
    const chunkSummary = summarizeChunkTokens(chunks.map((chunk) => chunk.token_count));

    await emitProgress("chunked", {
      job_id: job.id,
      chunk_count: chunkSummary.chunk_count,
      token_min: chunkSummary.token_min,
      token_max: chunkSummary.token_max,
      token_avg: chunkSummary.token_avg,
      histogram_bins: chunkSummary.histogram_bins
    });

    const embeddingBatch = await this.embeddingService.embedBatch(chunks.map((chunk) => chunk.content));
    const embeddedChunks = chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddingBatch.vectors[index]
    }));
    const embeddingCost = embeddingCostUsd(
      embeddingBatch.telemetry.total_tokens,
      this.telemetryConfig.embeddingUsdPer1MTokens
    );

    await emitProgress("embedded", {
      job_id: job.id,
      embedding_count: embeddedChunks.length,
      embedding_model: embeddingBatch.telemetry.model,
      embedding_provider: embeddingBatch.telemetry.provider,
      embedding_dimensions: embeddingBatch.telemetry.dimensions,
      embedding_prompt_tokens: embeddingBatch.telemetry.prompt_tokens,
      embedding_total_tokens: embeddingBatch.telemetry.total_tokens,
      embedding_cost_usd: embeddingCost,
      token_source: embeddingBatch.telemetry.token_source
    });

    await this.ragStore.upsertDocumentParts(document.id, parsed.parts);
    await this.ragStore.replaceDocumentChunks(document.id, embeddedChunks);

    await emitProgress("indexed", {
      job_id: job.id,
      indexed_chunks: embeddedChunks.length
    });

    await this.ragStore.updateDocument(document.id, {
      parse_status: "parsed",
      ocr_status: parsed.ocr_status
    });

    await this.ragStore.updateIngestionJob(job.id, {
      status: "completed",
      ended_at: new Date().toISOString()
    });

    await emitProgress("completed", {
      job_id: job.id,
      summary: {
        filename: document.filename,
        mime_type: document.mime_type,
        file_size_bytes: buffer.length,
        parts: parsed.parts.length,
        chunk_count: chunkSummary.chunk_count,
        raw_token_count: rawTokenCount,
        normalized_token_count: normalizedTokenCount,
        embedding_model: embeddingBatch.telemetry.model,
        embedding_total_tokens: embeddingBatch.telemetry.total_tokens,
        embedding_cost_usd: embeddingCost,
        duration_ms: Math.max(0, Date.now() - runStartedMs)
      }
    });
  }
}

const INGESTION_PHASE_ORDER: Record<IngestionPhase, number> = {
  uploaded: 1,
  parsed: 2,
  ocr: 3,
  normalized: 4,
  chunked: 5,
  embedded: 6,
  indexed: 7,
  completed: 8,
  failed: 9,
  cancelled: 10
};

function shouldEmitIngestionPhase(
  currentPhase: IngestionPhase | undefined,
  nextPhase: IngestionPhase
): boolean {
  if (!currentPhase) {
    return true;
  }

  return INGESTION_PHASE_ORDER[nextPhase] > INGESTION_PHASE_ORDER[currentPhase];
}

function asIngestionPhase(phase: string | undefined): IngestionPhase | undefined {
  if (!phase) {
    return undefined;
  }

  return phase in INGESTION_PHASE_ORDER ? (phase as IngestionPhase) : undefined;
}

export function asInlineQueue(queue: InMemoryQueue): QueueLike {
  return {
    mode: "inline",
    enqueue: (runId, payload) => queue.enqueue(runId, payload),
    pendingJobs: () => queue.pendingJobs(),
    drainWithDeadLetter: (handler, onDeadLetter) => queue.drainWithDeadLetter(handler, onDeadLetter)
  };
}
