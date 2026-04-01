import { Hono } from "hono";
import type { Env } from "../../types";

type ConvApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const conversations = new Hono<ConvApp>();

conversations.get("/", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC",
  )
    .bind(userId)
    .all<{
      id: string;
      title: string | null;
      created_at: string;
      updated_at: string;
    }>();

  return c.json(
    results.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  );
});

conversations.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));
  const title = body.title ?? "New conversation";
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    "INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)",
  )
    .bind(id, userId, title)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    }>();

  return c.json(
    {
      id: row!.id,
      title: row!.title,
      createdAt: row!.created_at,
      updatedAt: row!.updated_at,
    },
    201,
  );
});

conversations.get("/:id", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("id");

  const conv = await c.env.DB.prepare(
    "SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE id = ?",
  )
    .bind(convId)
    .first<{
      id: string;
      user_id: string;
      title: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!conv) {
    return c.json({ error: "Conversation not found" }, 404);
  }
  if (conv.user_id !== userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [messagesResult, sessionsResult] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, role, content, tool_name, tool_params, tool_result, app_id, sequence_num, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence_num",
    )
      .bind(convId)
      .all(),
    c.env.DB.prepare(
      "SELECT id, app_id, status, state_summary, started_at, completed_at FROM app_sessions WHERE conversation_id = ? AND status = 'active'",
    )
      .bind(convId)
      .all(),
  ]);

  return c.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    messages: messagesResult.results.map((m: Record<string, unknown>) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolName: m.tool_name,
      toolParams: m.tool_params,
      toolResult: m.tool_result,
      appId: m.app_id,
      sequenceNum: m.sequence_num,
      createdAt: m.created_at,
    })),
    appSessions: sessionsResult.results.map((s: Record<string, unknown>) => ({
      id: s.id,
      appId: s.app_id,
      status: s.status,
      stateSummary: s.state_summary,
      startedAt: s.started_at,
      completedAt: s.completed_at,
    })),
  });
});

conversations.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("id");

  const conv = await c.env.DB.prepare(
    "SELECT user_id FROM conversations WHERE id = ?",
  )
    .bind(convId)
    .first<{ user_id: string }>();

  if (!conv) {
    return c.json({ error: "Conversation not found" }, 404);
  }
  if (conv.user_id !== userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(
      convId,
    ),
    c.env.DB.prepare("DELETE FROM app_sessions WHERE conversation_id = ?").bind(
      convId,
    ),
    c.env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(convId),
  ]);

  return c.json({ success: true });
});

export default conversations;
