import { v4 as uuidv4 } from "uuid";
import { IRagStore } from "../store/interfaces.js";
import { AnswerGenerator, RetrievalEngine } from "./contracts.js";

export class EvalService {
  constructor(
    private readonly ragStore: IRagStore,
    private readonly retrievalService: RetrievalEngine,
    private readonly answerService: AnswerGenerator
  ) {}

  async seedDefaults(): Promise<void> {
    if ((await this.ragStore.listEvalSets()).length > 0) {
      return;
    }

    const defaults = [
      {
        id: uuidv4(),
        name: "Markdown retrieval",
        query: "What are the key technical architecture decisions?",
        expected_doc_ids_json: [],
        expected_facts_json: ["architecture", "pipeline", "retrieval"]
      },
      {
        id: uuidv4(),
        name: "Spreadsheet retrieval",
        query: "What values are captured in table rows?",
        expected_doc_ids_json: [],
        expected_facts_json: ["rows", "columns"]
      },
      {
        id: uuidv4(),
        name: "PDF retrieval",
        query: "What process is described in the PDF content?",
        expected_doc_ids_json: [],
        expected_facts_json: ["process", "steps"]
      }
    ];

    for (const evalSet of defaults) {
      await this.ragStore.createEvalSet(evalSet);
    }
  }

  async run(projectId: string): Promise<{ metrics: Record<string, number>; report: Array<Record<string, unknown>> }> {
    const evalSets = await this.ragStore.listEvalSets();
    const report: Array<Record<string, unknown>> = [];

    const recallScores: number[] = [];
    const citationCoverageScores: number[] = [];
    const groundednessScores: number[] = [];
    const latencies: number[] = [];

    for (const evalSet of evalSets) {
      const started = Date.now();
      const retrieval = await this.retrievalService.retrieve(projectId, evalSet.query);
      const answer = await this.answerService.generateAnswer(evalSet.query, retrieval.rerankedCandidates);
      const latencyMs = Date.now() - started;

      const retrievedDocIds = new Set(retrieval.rerankedCandidates.map((candidate) => candidate.document_id));
      const expectedDocIds = evalSet.expected_doc_ids_json;

      const recall =
        expectedDocIds.length === 0
          ? Number(retrieval.rerankedCandidates.length > 0)
          : expectedDocIds.filter((id) => retrievedDocIds.has(id)).length / expectedDocIds.length;

      const citationCoverage = Number(answer.citations.length > 0);
      const groundedness = scoreGroundedness(answer.answer, answer.citations.map((citation) => citation.preview));

      recallScores.push(recall);
      citationCoverageScores.push(citationCoverage);
      groundednessScores.push(groundedness);
      latencies.push(latencyMs);

      report.push({
        eval_set_id: evalSet.id,
        name: evalSet.name,
        recall_at_k: recall,
        citation_coverage: citationCoverage,
        groundedness,
        latency_ms: latencyMs,
        top_chunks: retrieval.rerankedCandidates.slice(0, 3).map((candidate) => candidate.chunk_id)
      });
    }

    const metrics = {
      recall_at_k: average(recallScores),
      citation_coverage_rate: average(citationCoverageScores),
      answer_groundedness_score: average(groundednessScores),
      median_latency_ms: median(latencies),
      ingestion_success_rate: await ingestionSuccessRate(projectId, this.ragStore)
    };

    await this.ragStore.saveEvalRun({
      id: uuidv4(),
      started_at: new Date().toISOString(),
      metrics_json: metrics,
      report_json: report
    });

    return {
      metrics,
      report
    };
  }
}

function scoreGroundedness(answer: string, evidences: string[]): number {
  if (answer.trim().length === 0 || evidences.length === 0) {
    return 0;
  }

  const evidenceText = evidences.join(" ").toLowerCase();
  const answerTokens = answer
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/gi, ""))
    .filter((token) => token.length > 2);

  if (answerTokens.length === 0) {
    return 0;
  }

  const grounded = answerTokens.filter((token) => evidenceText.includes(token)).length;
  return grounded / answerTokens.length;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

async function ingestionSuccessRate(projectId: string, ragStore: IRagStore): Promise<number> {
  const jobs = await ragStore.listIngestionJobs(projectId);
  if (jobs.length === 0) {
    return 0;
  }

  const success = jobs.filter((job) => job.status === "completed").length;
  return success / jobs.length;
}
