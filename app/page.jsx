"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleHelp, Loader2, Pencil, Plus, RefreshCw, SendHorizontal, Trash2, Upload } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { buildHistogramLineData, formatBytes, formatPercent, formatUsd, safeText, toNumber } from "../lib/pipelinePopover";
import { cn } from "../lib/utils";

const INGESTION_PHASES = [
  "uploaded",
  "parsed",
  "ocr",
  "normalized",
  "chunked",
  "embedded",
  "indexed",
  "completed"
];

const QUERY_PHASES = [
  "query_received",
  "query_embedded",
  "retrieved_vector",
  "retrieved_bm25",
  "reranked",
  "context_built",
  "answer_streaming",
  "answered"
];

const ALL_PHASES = [...INGESTION_PHASES, ...QUERY_PHASES];
const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || "/");

const PHASE_DETAILS = {
  uploaded: {
    what: "The file is accepted and ingestion starts.",
    how: "The API stores bytes in MinIO, creates document metadata, enqueues a BullMQ job, and emits the first run event.",
    why: "Separating upload from processing keeps requests fast and gives reliable retries/recovery."
  },
  parsed: {
    what: "Source content is extracted into structured text parts.",
    how: "The worker reads the object and `parseDocument` handles PDF/MD/TXT/CSV/XLSX parsing into a common part model.",
    why: "One normalized parse shape keeps downstream chunking/indexing format-agnostic."
  },
  ocr: {
    what: "Optical character recognition is tracked when required.",
    how: "The parser reports `ocr_status`; this phase is emitted only if OCR is actually performed.",
    why: "Explicit OCR visibility makes parser behavior and latency easier to debug."
  },
  normalized: {
    what: "Parsed text is standardized for search and chunking.",
    how: "Tokens and metadata are normalized before chunk generation.",
    why: "Normalization reduces noise and improves retrieval consistency across file types."
  },
  chunked: {
    what: "Long content is split into retrievable segments.",
    how: "`chunkDocumentParts` uses token windows (target 500, overlap 80, max 900).",
    why: "Overlapped windows preserve context while keeping chunks embedding-friendly."
  },
  embedded: {
    what: "Each chunk gets a vector embedding.",
    how: "The embedding adapter batches chunk content and returns vectors attached to each chunk.",
    why: "Batch embedding is faster and enables semantic nearest-neighbor retrieval."
  },
  indexed: {
    what: "Chunks become queryable in storage.",
    how: "Parts and chunk rows are written to Postgres/pgvector, including lexical search fields.",
    why: "Hybrid indexing supports both semantic and keyword retrieval paths."
  },
  completed: {
    what: "Ingestion run reaches terminal success.",
    how: "Job state and run projection are marked completed and a terminal event is appended.",
    why: "A single terminal marker gives deterministic run lifecycle semantics."
  },
  query_received: {
    what: "A user question is accepted and query run starts.",
    how: "User message is persisted, run state is created, and the start event is emitted.",
    why: "Durable run start enables replayable timelines and correlation across logs."
  },
  query_embedded: {
    what: "The question is encoded as an embedding vector.",
    how: "The retrieval service calls the embedding adapter for query text.",
    why: "Query vectors are required for semantic similarity search."
  },
  retrieved_vector: {
    what: "Semantic candidates are fetched.",
    how: "Vector similarity scoring ranks chunk candidates and returns top matches.",
    why: "Vector retrieval finds relevant meaning even with different wording."
  },
  retrieved_bm25: {
    what: "Lexical candidates are fetched.",
    how: "BM25 ranks chunks using token statistics and term overlap.",
    why: "Keyword retrieval improves precision for exact terms, IDs, and names."
  },
  reranked: {
    what: "Candidate lists are fused and reordered.",
    how: "Reciprocal-rank fusion combines vector + BM25, then token-overlap reranking refines order.",
    why: "Fusion improves robustness and final relevance compared to a single retriever."
  },
  context_built: {
    what: "Prompt context is assembled for generation.",
    how: "Chat memory service combines rolling summary and recent turns.",
    why: "Bounded context preserves continuity while controlling token cost."
  },
  answer_streaming: {
    what: "Answer generation starts and stream updates are sent.",
    how: "The answer adapter generates a response and the API emits SSE token/citation events to the UI.",
    why: "Streaming reduces perceived latency and keeps the run observable in real time."
  },
  answered: {
    what: "Final answer and trace are committed.",
    how: "Assistant message is persisted, retrieval trace is linked to it, then the terminal query event is emitted.",
    why: "Trace-linked persistence guarantees explainability and reproducible citations."
  }
};

function createPendingPipeline() {
  return Object.fromEntries(ALL_PHASES.map((phase) => [phase, "pending"]));
}

function detectRunType(events) {
  if (events.some((event) => QUERY_PHASES.includes(event.phase))) {
    return "query";
  }
  if (events.some((event) => INGESTION_PHASES.includes(event.phase))) {
    return "ingestion";
  }
  return null;
}

function buildPipelineState(events) {
  const next = createPendingPipeline();
  if (!events.length) {
    return next;
  }

  const runType = detectRunType(events);
  const visiblePhases =
    runType === "query" ? new Set(QUERY_PHASES) : runType === "ingestion" ? new Set(INGESTION_PHASES) : new Set(ALL_PHASES);

  const latest = events[events.length - 1];
  for (const event of events) {
    if (!visiblePhases.has(event.phase)) {
      continue;
    }
    next[event.phase] = event.seq === latest.seq ? event.status : "completed";
  }

  return next;
}

function buildPhaseEventMap(events) {
  const phaseMap = {};
  for (const event of events) {
    phaseMap[event.phase] = event;
  }
  return phaseMap;
}

function MetricRow({ label, value }) {
  return (
    <p className="text-xs leading-relaxed text-slate-100">
      <span className="font-semibold text-cyan-100">{label}:</span> {value}
    </p>
  );
}

function PipelinePhaseRunData({
  phase,
  payload,
  documentsById,
  isContextExpanded,
  onToggleContext
}) {
  if (!payload || typeof payload !== "object") {
    return <p className="text-xs text-muted-foreground">No runtime telemetry for this phase yet.</p>;
  }

  if (phase === "uploaded") {
    const documentName =
      safeText(payload.filename, "") ||
      safeText(documentsById.get(payload.document_id)?.filename, "Not available.");
    return (
      <div className="space-y-1.5">
        <MetricRow label="File" value={documentName} />
        <MetricRow label="Mime Type" value={safeText(payload.mime_type)} />
        <MetricRow label="File Size" value={formatBytes(payload.file_size_bytes)} />
      </div>
    );
  }

  if (phase === "parsed") {
    return (
      <div className="space-y-1.5">
        <MetricRow label="Parser" value={safeText(payload.parser_kind)} />
        <MetricRow label="Mime Type" value={safeText(payload.mime_type)} />
        <MetricRow label="Parts" value={toNumber(payload.parts).toString()} />
        <MetricRow label="Raw Chars" value={toNumber(payload.raw_char_count).toString()} />
        <MetricRow label="Raw Tokens" value={toNumber(payload.raw_token_count).toString()} />
      </div>
    );
  }

  if (phase === "normalized") {
    return (
      <div className="space-y-1.5">
        <MetricRow label="Normalized Chars" value={toNumber(payload.normalized_char_count).toString()} />
        <MetricRow label="Normalized Tokens" value={toNumber(payload.normalized_token_count).toString()} />
        <MetricRow label="Reduction" value={formatPercent(payload.reduction_pct)} />
      </div>
    );
  }

  if (phase === "chunked") {
    const chartData = buildHistogramLineData(payload.histogram_bins);
    return (
      <div className="space-y-2.5">
        <MetricRow label="Chunks" value={toNumber(payload.chunk_count).toString()} />
        <MetricRow label="Token Range" value={`${toNumber(payload.token_min)} - ${toNumber(payload.token_max)}`} />
        <MetricRow label="Average Tokens" value={toNumber(payload.token_avg).toFixed(2)} />
        {chartData.length > 0 ? (
          <div className="rounded-md border border-slate-700/70 bg-slate-900/50 p-2">
            <p className="mb-1.5 text-[11px] text-cyan-100">Chunk Size Distribution</p>
            <ChartContainer className="h-[120px]">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.24)" />
                <XAxis dataKey="range" tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 10 }} width={26} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line type="monotone" dataKey="count" stroke="rgba(34, 211, 238, 0.95)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          </div>
        ) : null}
      </div>
    );
  }

  if (phase === "embedded" || phase === "query_embedded") {
    return (
      <div className="space-y-1.5">
        <MetricRow label="Model" value={safeText(payload.embedding_model)} />
        <MetricRow label="Provider" value={safeText(payload.embedding_provider)} />
        <MetricRow label="Dimensions" value={toNumber(payload.embedding_dimensions).toString()} />
        <MetricRow label="Prompt Tokens" value={toNumber(payload.embedding_prompt_tokens).toString()} />
        <MetricRow label="Total Tokens" value={toNumber(payload.embedding_total_tokens).toString()} />
        <MetricRow label="Token Source" value={safeText(payload.token_source)} />
        <MetricRow label="Cost (USD)" value={formatUsd(payload.embedding_cost_usd)} />
      </div>
    );
  }

  if (phase === "context_built") {
    const preview = safeText(payload.context_preview);
    const full = safeText(payload.context_full_redacted);
    const hasToggle = full.length > 0 && full !== preview;
    return (
      <div className="space-y-2">
        <MetricRow label="Summary Chars" value={toNumber(payload.summary_chars).toString()} />
        <MetricRow label="Recent Turns" value={toNumber(payload.recent_turns).toString()} />
        <MetricRow label="Truncated" value={payload.context_truncated ? "yes" : "no"} />
        <MetricRow label="Redacted" value={payload.context_redaction_applied ? "yes" : "no"} />
        <div className="rounded-md border border-slate-700/70 bg-slate-900/50 p-2">
          <p className="mb-1 text-[11px] text-cyan-100">Context Preview</p>
          <p className="whitespace-pre-wrap break-words text-xs text-slate-100">
            {isContextExpanded ? full : preview}
          </p>
          {hasToggle ? (
            <button
              type="button"
              className="mt-2 text-[11px] font-medium text-cyan-200 hover:text-cyan-100"
              onClick={onToggleContext}
            >
              {isContextExpanded ? "Hide full context" : "Show full context"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (phase === "completed") {
    const summary = payload.summary && typeof payload.summary === "object" ? payload.summary : {};
    return (
      <div className="space-y-1.5">
        <MetricRow label="File" value={safeText(summary.filename)} />
        <MetricRow label="Mime Type" value={safeText(summary.mime_type)} />
        <MetricRow label="File Size" value={formatBytes(summary.file_size_bytes)} />
        <MetricRow label="Parts" value={toNumber(summary.parts).toString()} />
        <MetricRow label="Chunks" value={toNumber(summary.chunk_count).toString()} />
        <MetricRow label="Embedding Model" value={safeText(summary.embedding_model)} />
        <MetricRow label="Embedding Tokens" value={toNumber(summary.embedding_total_tokens).toString()} />
        <MetricRow label="Embedding Cost (USD)" value={formatUsd(summary.embedding_cost_usd)} />
        <MetricRow label="Duration" value={`${toNumber(summary.duration_ms)} ms`} />
      </div>
    );
  }

  if (phase === "answered") {
    return (
      <div className="space-y-1.5">
        <MetricRow label="Model" value={safeText(payload.answer_model)} />
        <MetricRow label="Prompt Tokens" value={toNumber(payload.answer_prompt_tokens).toString()} />
        <MetricRow label="Completion Tokens" value={toNumber(payload.answer_completion_tokens).toString()} />
        <MetricRow label="Answer Tokens" value={toNumber(payload.answer_total_tokens).toString()} />
        <MetricRow label="Query Embedding Tokens" value={toNumber(payload.query_embedding_tokens).toString()} />
        <MetricRow label="Answer Cost (USD)" value={formatUsd(payload.answer_cost_usd)} />
        <MetricRow label="Query Embedding Cost (USD)" value={formatUsd(payload.query_embedding_cost_usd)} />
        <MetricRow label="Total Cost (USD)" value={formatUsd(payload.total_cost_usd)} />
        <MetricRow label="Answer Time" value={`${toNumber(payload.answer_latency_ms)} ms`} />
      </div>
    );
  }

  if (phase === "query_received" || phase === "retrieved_vector" || phase === "retrieved_bm25" || phase === "reranked" || phase === "answer_streaming" || phase === "indexed" || phase === "ocr") {
    return (
      <div className="space-y-1.5">
        {Object.entries(payload).map(([key, value]) => (
          <MetricRow
            key={key}
            label={key.replaceAll("_", " ")}
            value={typeof value === "number" ? value.toString() : safeText(value)}
          />
        ))}
      </div>
    );
  }

  return <p className="text-xs text-muted-foreground">No runtime telemetry mapped for this phase.</p>;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getPipelineTone(status) {
  if (status === "in_progress" || status === "started") {
    return "border-sky-400/70 bg-sky-500/10 text-sky-100 animate-pulse";
  }
  if (status === "completed") {
    return "border-emerald-400/70 bg-emerald-500/10 text-emerald-100";
  }
  if (status === "failed" || status === "cancelled") {
    return "border-red-400/70 bg-red-500/10 text-red-100";
  }
  return "border-border/70 bg-slate-900/35 text-muted-foreground";
}

function formatReference(location) {
  if (!location || location === "chunk") {
    return "chunk";
  }

  if (location.startsWith("page-")) {
    return location.replace("page-", "page ");
  }

  if (location.startsWith("section-")) {
    return location.replace("section-", "section ");
  }

  if (location.startsWith("chunk-")) {
    return location.replace("chunk-", "chunk ");
  }

  if (location.startsWith("sheet-")) {
    return location.replace("sheet-", "sheet ");
  }

  if (location.startsWith("text-")) {
    return location.replace("text-", "text ");
  }

  return location;
}

function formatCitationLabel(citation, documentsById) {
  const filename = documentsById.get(citation.document_id)?.filename ?? `doc-${citation.document_id.slice(0, 8)}`;
  return `${filename}:${formatReference(citation.location)}`;
}

function formatCitationPreview(citation) {
  if (typeof citation.preview !== "string") {
    return "No citation preview available.";
  }

  const trimmed = citation.preview.trim();
  return trimmed.length > 0 ? trimmed : "No citation preview available.";
}

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/";
}

function withBasePath(path) {
  if (BASE_PATH === "/") {
    return path;
  }

  if (!path.startsWith("/")) {
    return `${BASE_PATH}/${path}`;
  }

  return `${BASE_PATH}${path}`;
}

export default function HomePage() {
  const [projects, setProjects] = useState([]);
  const [chats, setChats] = useState([]);
  const [docs, setDocs] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [composer, setComposer] = useState("");
  const [pipeline, setPipeline] = useState(() => createPendingPipeline());
  const [phaseEvents, setPhaseEvents] = useState({});
  const [activeRunId, setActiveRunId] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [expandedContextPhases, setExpandedContextPhases] = useState({});

  const eventSourceRef = useRef(null);
  const runEventsRef = useRef(new Map());
  const fileInputRef = useRef(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId]
  );
  const documentsById = useMemo(() => new Map(docs.map((doc) => [doc.id, doc])), [docs]);

  const closeRunStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const resetPipeline = useCallback(() => {
    runEventsRef.current.clear();
    setPipeline(createPendingPipeline());
    setPhaseEvents({});
    setExpandedContextPhases({});
  }, []);

  useEffect(() => {
    return () => closeRunStream();
  }, [closeRunStream]);

  const requestJson = useCallback(async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed (${response.status})`);
    }
    return response.json();
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await requestJson(withBasePath("/api/projects"));
    const nextProjects = data.projects || [];
    setProjects(nextProjects);
    setSelectedProjectId((previous) => {
      if (previous && nextProjects.some((project) => project.id === previous)) {
        return previous;
      }
      return nextProjects[0]?.id ?? null;
    });
  }, [requestJson]);

  const loadMessagesForChat = useCallback(
    async (projectId, chatId) => {
      if (!projectId || !chatId) {
        setMessages([]);
        return;
      }
      const data = await requestJson(withBasePath(`/api/projects/${projectId}/chats/${chatId}/messages?limit=100`));
      setMessages(data.messages || []);
    },
    [requestJson]
  );

  const trackRun = useCallback(
    (runId, projectId) => {
      if (!projectId) {
        return;
      }

      closeRunStream();
      setActiveRunId(runId);
      resetPipeline();

      const source = new EventSource(withBasePath(`/api/projects/${projectId}/runs/${runId}/events`));
      source.addEventListener("run_event", (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (!ALL_PHASES.includes(payload.phase)) {
            return;
          }

          runEventsRef.current.set(payload.seq, payload);
          const ordered = [...runEventsRef.current.values()].sort((a, b) => a.seq - b.seq);
          setPipeline(buildPipelineState(ordered));
          setPhaseEvents(buildPhaseEventMap(ordered));
        } catch {
          // Keep stream alive on malformed event payloads.
        }
      });

      source.onerror = () => {
        // Native EventSource reconnect handles transient disconnects.
      };

      eventSourceRef.current = source;
    },
    [closeRunStream, resetPipeline]
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await loadProjects();
      } catch (loadError) {
        if (active) {
          setError(getErrorMessage(loadError));
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setChats([]);
      setDocs([]);
      setSelectedChatId(null);
      setMessages([]);
      closeRunStream();
      setActiveRunId(null);
      resetPipeline();
      return;
    }

    let active = true;
    closeRunStream();
    setActiveRunId(null);
    resetPipeline();
    setChats([]);
    setDocs([]);
    setSelectedChatId(null);
    setMessages([]);

    void (async () => {
      try {
        const [chatData, docData] = await Promise.all([
          requestJson(withBasePath(`/api/projects/${selectedProjectId}/chats`)),
          requestJson(withBasePath(`/api/projects/${selectedProjectId}/documents`))
        ]);

        if (!active) {
          return;
        }

        const nextChats = chatData.chats || [];
        setChats(nextChats);
        setDocs(docData.documents || []);
        setSelectedChatId(nextChats[0]?.id ?? null);
      } catch (loadError) {
        if (active) {
          setError(getErrorMessage(loadError));
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [selectedProjectId, closeRunStream, requestJson, resetPipeline]);

  useEffect(() => {
    const selectedChat = chats.find((chat) => chat.id === selectedChatId && chat.project_id === selectedProjectId);
    if (!selectedProjectId || !selectedChatId || !selectedChat) {
      setMessages([]);
      return;
    }

    let active = true;
    void (async () => {
      try {
        await loadMessagesForChat(selectedProjectId, selectedChatId);
      } catch (loadError) {
        if (active) {
          setError(getErrorMessage(loadError));
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [chats, selectedProjectId, selectedChatId, loadMessagesForChat]);

  const handleCreateProject = useCallback(async () => {
    const name = window.prompt("Project name");
    if (!name || !name.trim()) {
      return;
    }

    setError("");
    try {
      const created = await requestJson(withBasePath("/api/projects"), {
        method: "POST",
        body: JSON.stringify({ name: name.trim() })
      });
      await loadProjects();
      setSelectedProjectId(created.id ?? created.project_id ?? null);
    } catch (createError) {
      setError(getErrorMessage(createError));
    }
  }, [loadProjects, requestJson]);

  const handleRenameProject = useCallback(
    async (projectId, currentName) => {
      const nextName = window.prompt("Project name", currentName);
      if (nextName === null) {
        return;
      }

      const trimmed = nextName.trim();
      if (!trimmed) {
        setError("Project name cannot be empty.");
        return;
      }

      setError("");
      try {
        await requestJson(withBasePath(`/api/projects/${projectId}`), {
          method: "PATCH",
          body: JSON.stringify({ name: trimmed })
        });
        await loadProjects();
      } catch (renameError) {
        setError(getErrorMessage(renameError));
      }
    },
    [loadProjects, requestJson]
  );

  const handleDeleteProject = useCallback(
    async (projectId, projectName) => {
      const confirmed = window.confirm(`Delete project "${projectName}"? This removes chats, messages, traces, and documents.`);
      if (!confirmed) {
        return;
      }

      setError("");
      try {
        const response = await fetch(withBasePath(`/api/projects/${projectId}`), {
          method: "DELETE"
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Failed to delete project");
        }

        if (selectedProjectId === projectId) {
          closeRunStream();
          setActiveRunId(null);
          resetPipeline();
          setSelectedChatId(null);
          setChats([]);
          setDocs([]);
          setMessages([]);
        }

        await loadProjects();
      } catch (deleteError) {
        setError(getErrorMessage(deleteError));
      }
    },
    [closeRunStream, loadProjects, resetPipeline, selectedProjectId]
  );

  const handleCreateChat = useCallback(async () => {
    if (!selectedProjectId) {
      setError("Select a project first.");
      return;
    }

    const title = window.prompt("Chat title", "New chat");
    if (!title || !title.trim()) {
      return;
    }

    setError("");
    try {
      const created = await requestJson(withBasePath(`/api/projects/${selectedProjectId}/chats`), {
        method: "POST",
        body: JSON.stringify({ title: title.trim() })
      });
      setChats((previous) => [created, ...previous]);
      setSelectedChatId(created.id);
      await loadMessagesForChat(selectedProjectId, created.id);
    } catch (createError) {
      setError(getErrorMessage(createError));
    }
  }, [loadMessagesForChat, requestJson, selectedProjectId]);

  const handleRenameChat = useCallback(
    async (chatId, currentTitle) => {
      if (!selectedProjectId) {
        setError("Select a project first.");
        return;
      }

      const nextTitle = window.prompt("Chat title", currentTitle);
      if (nextTitle === null) {
        return;
      }

      const trimmed = nextTitle.trim();
      if (!trimmed) {
        setError("Chat title cannot be empty.");
        return;
      }

      setError("");
      try {
        const updated = await requestJson(withBasePath(`/api/projects/${selectedProjectId}/chats/${chatId}`), {
          method: "PATCH",
          body: JSON.stringify({ title: trimmed })
        });

        setChats((previous) => previous.map((chat) => (chat.id === chatId ? updated : chat)));
      } catch (renameError) {
        setError(getErrorMessage(renameError));
      }
    },
    [requestJson, selectedProjectId]
  );

  const handleDeleteChat = useCallback(
    async (chatId, chatTitle) => {
      if (!selectedProjectId) {
        setError("Select a project first.");
        return;
      }

      const confirmed = window.confirm(`Delete chat "${chatTitle}"? This removes all messages and traces in this chat.`);
      if (!confirmed) {
        return;
      }

      setError("");
      try {
        const response = await fetch(withBasePath(`/api/projects/${selectedProjectId}/chats/${chatId}`), {
          method: "DELETE"
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Failed to delete chat");
        }

        const data = await requestJson(withBasePath(`/api/projects/${selectedProjectId}/chats`));
        const nextChats = data.chats || [];
        const stillSelected = nextChats.some((chat) => chat.id === selectedChatId);
        const nextSelectedChatId = stillSelected ? selectedChatId : nextChats[0]?.id ?? null;

        setChats(nextChats);
        setSelectedChatId(nextSelectedChatId);
        await loadMessagesForChat(selectedProjectId, nextSelectedChatId);

        if (!nextSelectedChatId) {
          closeRunStream();
          setActiveRunId(null);
          resetPipeline();
        }
      } catch (deleteError) {
        setError(getErrorMessage(deleteError));
      }
    },
    [closeRunStream, loadMessagesForChat, requestJson, resetPipeline, selectedChatId, selectedProjectId]
  );

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setError("");
    try {
      await loadProjects();
      if (selectedProjectId) {
        const [chatData, docData] = await Promise.all([
          requestJson(withBasePath(`/api/projects/${selectedProjectId}/chats`)),
          requestJson(withBasePath(`/api/projects/${selectedProjectId}/documents`))
        ]);
        setChats(chatData.chats || []);
        setDocs(docData.documents || []);

        if (selectedChatId) {
          await loadMessagesForChat(selectedProjectId, selectedChatId);
        }
      }
    } catch (refreshError) {
      setError(getErrorMessage(refreshError));
    } finally {
      setIsRefreshing(false);
    }
  }, [loadMessagesForChat, loadProjects, requestJson, selectedProjectId, selectedChatId]);

  const handleUploadChange = useCallback(
    async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";

      if (!selectedProjectId || files.length === 0) {
        return;
      }

      setIsUploading(true);
      setError("");

      const failures = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        try {
          const response = await fetch(withBasePath(`/api/projects/${selectedProjectId}/documents`), {
            method: "POST",
            body: formData
          });

          if (!response.ok) {
            failures.push(`${file.name}: ${await response.text()}`);
            continue;
          }

          const payload = await response.json();
          const runId = payload?.ingestion_job?.run_id;
          if (runId) {
            trackRun(runId, selectedProjectId);
          }
        } catch (uploadError) {
          failures.push(`${file.name}: ${getErrorMessage(uploadError)}`);
        }
      }

      try {
        const data = await requestJson(withBasePath(`/api/projects/${selectedProjectId}/documents`));
        setDocs(data.documents || []);
      } catch (refreshError) {
        failures.push(getErrorMessage(refreshError));
      }

      if (failures.length) {
        setError(failures.join(" | "));
      }
      setIsUploading(false);
    },
    [requestJson, selectedProjectId, trackRun]
  );

  const sendMessage = useCallback(async () => {
    if (!selectedProjectId || !selectedChatId || isSending) {
      return;
    }

    const content = composer.trim();
    if (!content) {
      return;
    }

    setError("");
    setComposer("");
    setIsSending(true);

    const userTempId = `user-${Date.now()}`;
    const assistantTempId = `assistant-${Date.now()}`;
    setMessages((previous) => [
      ...previous,
      { id: userTempId, role: "user", content, citations_json: [] },
      { id: assistantTempId, role: "assistant", content: "", citations_json: [] }
    ]);

    try {
      const response = await fetch(withBasePath(`/api/projects/${selectedProjectId}/chats/${selectedChatId}/messages`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({ content, stream: true })
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(text || "Message failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (!eventLine || !dataLine) {
            continue;
          }

          const eventName = eventLine.slice(6).trim();
          let payload;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }

          if (eventName === "run_ref" && payload?.run_id) {
            trackRun(payload.run_id, selectedProjectId);
          }

          if (eventName === "token") {
            const token = payload?.token || "";
            if (!token) {
              continue;
            }
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantTempId ? { ...message, content: `${message.content || ""}${token}` } : message
              )
            );
          }

          if (eventName === "citation") {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantTempId
                  ? {
                      ...message,
                      citations_json: [...(message.citations_json || []), payload]
                    }
                  : message
              )
            );
          }
        }
      }

      await loadMessagesForChat(selectedProjectId, selectedChatId);
    } catch (sendError) {
      setError(getErrorMessage(sendError));
      await loadMessagesForChat(selectedProjectId, selectedChatId);
    } finally {
      setIsSending(false);
    }
  }, [composer, isSending, loadMessagesForChat, selectedChatId, selectedProjectId, trackRun]);

  return (
    <div className="min-h-screen bg-workspace-gradient">
      <div className="mx-auto flex min-h-screen w-full max-w-[1880px] flex-col gap-4 p-4 xl:h-screen xl:flex-row">
        <Card className="flex w-full shrink-0 flex-col border-cyan-900/40 bg-slate-950/70 xl:w-[320px]">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm uppercase tracking-[0.2em] text-cyan-200/80">Projects</CardTitle>
              <Button size="sm" variant="secondary" onClick={handleCreateProject}>
                <Plus className="h-4 w-4" />
                New
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1 scroll-thin">
              {projects.map((project) => (
                <div key={project.id} className="flex items-center gap-2">
                  <Button
                    variant={project.id === selectedProjectId ? "default" : "ghost"}
                    className="flex-1 justify-start truncate"
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    {project.name}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    aria-label={`Rename project ${project.name}`}
                    onClick={() => void handleRenameProject(project.id, project.name)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 text-red-300 hover:text-red-200"
                    aria-label={`Delete project ${project.name}`}
                    onClick={() => void handleDeleteProject(project.id, project.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <CardTitle className="text-sm uppercase tracking-[0.2em] text-cyan-200/80">Chats</CardTitle>
              <Button size="sm" variant="secondary" disabled={!selectedProjectId} onClick={handleCreateChat}>
                <Plus className="h-4 w-4" />
                New
              </Button>
            </div>

            <div className="max-h-40 space-y-2 overflow-y-auto pr-1 scroll-thin">
              {chats.map((chat) => (
                <div key={chat.id} className="flex items-center gap-2">
                  <Button
                    variant={chat.id === selectedChatId ? "default" : "ghost"}
                    className="flex-1 justify-start truncate"
                    onClick={() => setSelectedChatId(chat.id)}
                  >
                    {chat.title}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    aria-label={`Rename chat ${chat.title}`}
                    onClick={() => void handleRenameChat(chat.id, chat.title)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 text-red-300 hover:text-red-200"
                    aria-label={`Delete chat ${chat.title}`}
                    onClick={() => void handleDeleteChat(chat.id, chat.title)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <Separator />

            <div className="space-y-3">
              <CardTitle className="text-sm uppercase tracking-[0.2em] text-cyan-200/80">Documents</CardTitle>
              <Input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUploadChange} />
              <Button className="w-full" variant="secondary" disabled={!selectedProjectId || isUploading} onClick={() => fileInputRef.current?.click()}>
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload Files
              </Button>
              <div className="max-h-52 space-y-2 overflow-y-auto rounded-md border border-border/70 bg-slate-900/50 p-2 pr-1 scroll-thin">
                {docs.map((doc) => (
                  <div key={doc.id} className="rounded-md border border-border/50 bg-slate-900/50 p-2">
                    <p className="truncate text-sm font-medium">{doc.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {doc.parse_status} • OCR {doc.ocr_status}
                    </p>
                  </div>
                ))}
                {docs.length === 0 ? <p className="text-xs text-muted-foreground">No documents yet.</p> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col border-cyan-900/40 bg-slate-950/70 xl:flex-1">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">{selectedProject?.name || "Select a project"}</CardTitle>
                <CardDescription>
                  {selectedProject?.description || "Project-scoped memory, retrieval, and traceable assistant responses."}
                </CardDescription>
              </div>
              <Button variant="secondary" size="sm" disabled={isRefreshing} onClick={handleRefresh}>
                {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
            {error ? (
              <Badge variant="destructive" className="mt-3 w-fit">
                {error}
              </Badge>
            ) : null}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
            {!selectedProject ? (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border/60 bg-slate-950/55 p-6">
                <div className="max-w-md space-y-3 text-center">
                  <p className="text-lg font-semibold text-cyan-100">Create a project to start</p>
                  <p className="text-sm text-muted-foreground">
                    Projects isolate documents, vectors, and chats. Start by creating your first project workspace.
                  </p>
                  <Button size="sm" variant="secondary" onClick={handleCreateProject}>
                    <Plus className="h-4 w-4" />
                    New Project
                  </Button>
                </div>
              </div>
            ) : !selectedChatId ? (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border/60 bg-slate-950/55 p-6">
                <div className="max-w-md space-y-3 text-center">
                  <p className="text-lg font-semibold text-cyan-100">Create a chat to continue</p>
                  <p className="text-sm text-muted-foreground">
                    Chats keep context windows independent inside this project. Open a chat to start asking questions.
                  </p>
                  <Button size="sm" variant="secondary" onClick={handleCreateChat}>
                    <Plus className="h-4 w-4" />
                    New Chat
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="scroll-thin flex-1 space-y-4 overflow-y-auto rounded-xl border border-border/60 bg-slate-950/55 p-4">
                  {messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Start a conversation in this project chat.</p>
                  ) : (
                    messages.map((message) => {
                      const isUser = message.role === "user";
                      return (
                        <article
                          key={message.id}
                          className={cn(
                            "max-w-[90%] rounded-2xl border px-4 py-3 text-sm leading-relaxed shadow-sm animate-in fade-in slide-in-from-bottom-2",
                            isUser
                              ? "ml-auto border-cyan-400/50 bg-cyan-500/15 text-cyan-50"
                              : "mr-auto border-slate-700/90 bg-slate-900/90 text-slate-100"
                          )}
                        >
                          <p className="whitespace-pre-wrap">{message.content || ""}</p>
                      {!isUser && Array.isArray(message.citations_json) && message.citations_json.length > 0 ? (
                        <div className="mt-3 border-t border-slate-700/80 pt-2">
                          <div className="flex flex-wrap gap-2">
                            {message.citations_json.map((citation, index) => {
                              const label = formatCitationLabel(citation, documentsById);
                              const preview = formatCitationPreview(citation);
                              return (
                                <Popover key={`${citation.chunk_id ?? citation.document_id}-${index}`}>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      className="rounded-md border border-cyan-400/35 bg-cyan-500/10 px-2.5 py-1 font-mono text-[11px] text-cyan-200 transition-colors hover:bg-cyan-500/20"
                                    >
                                      {`[#${index + 1}] ${label}`}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    side="top"
                                    align="start"
                                    className="w-[min(520px,85vw)] space-y-2 border-slate-700 bg-slate-950"
                                  >
                                    <p className="font-mono text-[11px] text-cyan-200">{label}</p>
                                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-100">{preview}</p>
                                  </PopoverContent>
                                </Popover>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="rounded-xl border border-border/70 bg-slate-950/70 p-3">
                  <Textarea
                    rows={3}
                    placeholder="Message this project knowledge base..."
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <div className="mt-3 flex items-center justify-end">
                    <Button onClick={sendMessage} disabled={isSending || !selectedProjectId || !selectedChatId || composer.trim().length === 0}>
                      {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                      Send
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 w-full shrink-0 flex-col border-cyan-900/40 bg-slate-950/70 xl:w-[360px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-[0.2em] text-cyan-200/80">Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {ALL_PHASES.map((phase) => {
                const status = pipeline[phase] || "pending";
                const detail = PHASE_DETAILS[phase] ?? {
                  what: "Phase executed as part of the run lifecycle.",
                  how: "Emitted as an event in the run log and projected into UI state.",
                  why: "Keeps the pipeline observable and debuggable end-to-end."
                };
                const phaseEvent = phaseEvents[phase];
                const payload = phaseEvent?.payload;
                const isContextExpanded = Boolean(expandedContextPhases[phase]);

                return (
                  <Popover key={phase}>
                    <PopoverTrigger asChild>
                      <button type="button" className={cn("w-full rounded-lg border px-3 py-2 text-left text-sm", getPipelineTone(status))}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-mono text-xs uppercase tracking-wide">{phase}</p>
                            <p className="text-xs">{status}</p>
                          </div>
                          <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-85" />
                        </div>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="left"
                      align="start"
                      className="w-[min(520px,90vw)] max-h-[70vh] space-y-3 overflow-y-auto border-slate-700 bg-slate-950"
                    >
                      <div className="space-y-1.5">
                        <p className="font-mono text-[11px] uppercase tracking-wide text-cyan-200">{phase}</p>
                        <p className="leading-relaxed text-slate-100">
                          <span className="font-semibold text-cyan-100">What:</span> {detail.what}
                        </p>
                        <p className="leading-relaxed text-slate-100">
                          <span className="font-semibold text-cyan-100">How:</span> {detail.how}
                        </p>
                        <p className="leading-relaxed text-slate-100">
                          <span className="font-semibold text-cyan-100">Why:</span> {detail.why}
                        </p>
                      </div>
                      <Separator />
                      <div className="space-y-1">
                        <p className="font-mono text-[11px] uppercase tracking-wide text-cyan-200">Run Data</p>
                        <PipelinePhaseRunData
                          phase={phase}
                          payload={payload}
                          documentsById={documentsById}
                          isContextExpanded={isContextExpanded}
                          onToggleContext={() =>
                            setExpandedContextPhases((previous) => ({
                              ...previous,
                              [phase]: !previous[phase]
                            }))
                          }
                        />
                      </div>
                    </PopoverContent>
                  </Popover>
                );
              })}
            </div>

            <Separator className="shrink-0" />

            <div className="shrink-0 space-y-2 rounded-md border border-border/70 bg-slate-900/55 p-3">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Run</p>
              <p className="break-all font-mono text-xs text-cyan-100">{activeRunId || "No active run"}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
