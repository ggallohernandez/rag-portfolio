"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleHelp, Loader2, Plus, RefreshCw, SendHorizontal, Upload } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
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
  const [activeRunId, setActiveRunId] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");

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
        setSelectedChatId((previous) => {
          if (previous && nextChats.some((chat) => chat.id === previous)) {
            return previous;
          }
          return nextChats[0]?.id ?? null;
        });
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
  }, [selectedProjectId, selectedChatId, loadMessagesForChat]);

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
      <div className="mx-auto flex h-screen w-full max-w-[1880px] flex-col gap-4 p-4 xl:flex-row">
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
                <Button
                  key={project.id}
                  variant={project.id === selectedProjectId ? "default" : "ghost"}
                  className="w-full justify-start"
                  onClick={() => setSelectedProjectId(project.id)}
                >
                  {project.name}
                </Button>
              ))}
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <CardTitle className="text-sm uppercase tracking-[0.2em] text-cyan-200/80">Chats</CardTitle>
              <Button size="sm" variant="secondary" onClick={handleCreateChat}>
                <Plus className="h-4 w-4" />
                New
              </Button>
            </div>

            <div className="max-h-40 space-y-2 overflow-y-auto pr-1 scroll-thin">
              {chats.map((chat) => (
                <Button
                  key={chat.id}
                  variant={chat.id === selectedChatId ? "default" : "ghost"}
                  className="w-full justify-start"
                  onClick={() => setSelectedChatId(chat.id)}
                >
                  {chat.title}
                </Button>
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

        <Card className="flex min-h-0 flex-1 flex-col border-cyan-900/40 bg-slate-950/70">
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
                        <p className="mt-3 border-t border-slate-700/80 pt-2 font-mono text-[11px] text-cyan-200/80">
                          {message.citations_json.map((citation) => formatCitationLabel(citation, documentsById)).join(" • ")}
                        </p>
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
          </CardContent>
        </Card>

        <Card className="flex w-full shrink-0 flex-col border-cyan-900/40 bg-slate-950/70 xl:w-[360px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-[0.2em] text-cyan-200/80">Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <TooltipProvider delayDuration={160}>
              <div className="scroll-thin space-y-2 overflow-y-auto pr-1">
                {ALL_PHASES.map((phase) => {
                  const status = pipeline[phase] || "pending";
                  const detail = PHASE_DETAILS[phase] ?? {
                    what: "Phase executed as part of the run lifecycle.",
                    how: "Emitted as an event in the run log and projected into UI state.",
                    why: "Keeps the pipeline observable and debuggable end-to-end."
                  };

                  return (
                    <Tooltip key={phase}>
                      <TooltipTrigger asChild>
                        <div className={cn("rounded-lg border px-3 py-2 text-sm", getPipelineTone(status))}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-mono text-xs uppercase tracking-wide">{phase}</p>
                              <p className="text-xs">{status}</p>
                            </div>
                            <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-85" />
                          </div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" align="start" className="max-w-[340px] space-y-1.5">
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
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </TooltipProvider>

            <Separator />

            <div className="space-y-2 rounded-md border border-border/70 bg-slate-900/55 p-3">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Run</p>
              <p className="break-all font-mono text-xs text-cyan-100">{activeRunId || "No active run"}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
