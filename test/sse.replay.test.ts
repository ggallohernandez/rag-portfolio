import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

function parseSseData(payload: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of payload.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const json = line.slice("data: ".length);
    events.push(JSON.parse(json) as Record<string, unknown>);
  }

  return events;
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  const timeout = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (predicate(text)) {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }

  return text;
}

describe("SSE replay", () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const server of servers) {
      server.close();
    }
    servers.length = 0;
  });

  it("replays from Last-Event-ID without duplicate rendering", async () => {
    const container = await buildContainer();
    await container.store.createProject("p1");
    await container.store.createRun({ run_id: "r1", project_id: "p1", run_type: "ingestion" });

    const first = await container.emitter.emit({
      run_id: "r1",
      project_id: "p1",
      phase: "uploaded",
      status: "started",
      seq: 1,
      correlation_id: "corr"
    });

    await container.emitter.emit({
      run_id: "r1",
      project_id: "p1",
      phase: "parsed",
      status: "in_progress",
      seq: 2,
      correlation_id: "corr"
    });

    await container.emitter.emit({
      run_id: "r1",
      project_id: "p1",
      phase: "normalized",
      status: "in_progress",
      seq: 3,
      correlation_id: "corr"
    });

    const server = container.app.listen(0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/p1/runs/r1/events`, {
      headers: {
        "Last-Event-ID": first.event_id
      }
    });

    expect(response.status).toBe(200);
    if (!response.body) {
      throw new Error("expected SSE response body");
    }

    const payload = await readUntil(response.body, (text) => {
      return text.includes('"seq":2') && text.includes('"seq":3');
    });

    const events = parseSseData(payload);
    const seqs = events.map((event) => event.seq as number);

    expect(seqs).toEqual([2, 3]);

    const metrics = container.metrics.snapshot();
    expect(metrics.counters.replay_count).toBe(1);
  });
});
