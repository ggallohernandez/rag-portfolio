import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

describe("chat trace persistence order", () => {
  it("persists assistant message before retrieval trace", async () => {
    const container = await buildContainer();

    await container.store.createProject("p-order");
    await container.ragStore.createProject({
      id: "p-order",
      name: "Order",
      created_at: new Date().toISOString()
    });

    await container.ragStore.createChat({
      id: "c-order",
      project_id: "p-order",
      title: "Order chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const order: string[] = [];
    const originalAddMessage = container.ragStore.addMessage.bind(container.ragStore);
    const originalSaveTrace = container.ragStore.saveTrace.bind(container.ragStore);

    container.ragStore.addMessage = async (message) => {
      if (message.role === "assistant") {
        order.push("assistant_message");
      }
      return originalAddMessage(message);
    };

    container.ragStore.saveTrace = async (trace) => {
      order.push("trace");
      if (!order.includes("assistant_message")) {
        throw new Error("trace persisted before assistant message");
      }
      return originalSaveTrace(trace);
    };

    await container.chatService.ask("p-order", "c-order", "hello");

    expect(order).toEqual(["assistant_message", "trace"]);
  });
});
