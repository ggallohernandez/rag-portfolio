import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/bootstrap.js";

describe("project and chat CRUD", () => {
  it("renames and deletes chats/projects with cascading cleanup", async () => {
    const container = await buildContainer();
    const app = container.app;

    await request(app)
      .post("/api/projects")
      .send({ project_id: "crud-project", name: "Initial Project" })
      .expect(201);

    const renamedProject = await request(app)
      .patch("/api/projects/crud-project")
      .send({ name: "Renamed Project" })
      .expect(200);
    expect(renamedProject.body.name).toBe("Renamed Project");

    await request(app)
      .post("/api/projects/crud-project/chats")
      .send({ chat_id: "crud-chat", title: "Initial Chat" })
      .expect(201);

    const renamedChat = await request(app)
      .patch("/api/projects/crud-project/chats/crud-chat")
      .send({ title: "Renamed Chat" })
      .expect(200);
    expect(renamedChat.body.title).toBe("Renamed Chat");

    await request(app)
      .post("/api/projects/crud-project/chats/crud-chat/messages")
      .send({ content: "hello" })
      .expect(201);

    await request(app).delete("/api/projects/crud-project/chats/crud-chat").expect(204);

    await request(app).get("/api/projects/crud-project/chats/crud-chat/messages").expect(404);

    await request(app).delete("/api/projects/crud-project").expect(204);

    const projects = await request(app).get("/api/projects").expect(200);
    expect(projects.body.projects.some((project: { id: string }) => project.id === "crud-project")).toBe(false);

    await request(app).get("/api/projects/crud-project/chats").expect(404);
    await request(app).get("/api/projects/crud-project/documents").expect(404);
  });
});
