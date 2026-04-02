import { Hono } from "hono";
import type { Env } from "../../types";

type AppSessionsApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const appSessions = new Hono<AppSessionsApp>();

interface DbSessionRow {
  id: string;
  conversation_id: string;
  app_id: string;
  status: string;
  state_summary: string | null;
  state_raw: string | null;
  started_at: string;
  completed_at: string | null;
}

function toSession(row: DbSessionRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    appId: row.app_id,
    status: row.status,
    stateSummary: row.state_summary,
    stateRaw: row.state_raw,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ── POST / ──────────────────────────────────────────────────────────────

appSessions.post("/", async (c) => {
  const userId = c.get("userId");
  const { conversationId, appId } = await c.req.json<{
    conversationId: string;
    appId: string;
  }>();

  if (!conversationId || !appId) {
    return c.json({ error: "conversationId and appId are required" }, 400);
  }

  const conv = await c.env.DB.prepare(
    "SELECT user_id FROM conversations WHERE id = ?",
  )
    .bind(conversationId)
    .first<{ user_id: string }>();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  if (conv.user_id !== userId) return c.json({ error: "Forbidden" }, 403);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO app_sessions (id, conversation_id, app_id, status) VALUES (?, ?, ?, 'active')",
  )
    .bind(id, conversationId, appId)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT id, conversation_id, app_id, status, state_summary, state_raw, started_at, completed_at FROM app_sessions WHERE id = ?",
  )
    .bind(id)
    .first<DbSessionRow>();

  return c.json(toSession(row!), 201);
});

// ── PATCH /:id ──────────────────────────────────────────────────────────

appSessions.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");

  const existing = await c.env.DB.prepare(
    `SELECT s.id, s.conversation_id, s.app_id, s.status, s.state_summary, s.state_raw, s.started_at, s.completed_at
     FROM app_sessions s
     JOIN conversations c ON c.id = s.conversation_id
     WHERE s.id = ? AND c.user_id = ?`,
  )
    .bind(sessionId, userId)
    .first<DbSessionRow>();

  if (!existing) {
    return c.json({ error: "Session not found" }, 404);
  }

  const body = await c.req.json<{
    status?: string;
    stateSummary?: string;
    stateRaw?: string;
  }>();

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.status) {
    updates.push("status = ?");
    values.push(body.status);
    if (body.status === "completed" || body.status === "error") {
      updates.push("completed_at = datetime('now')");
    }
  }
  if (body.stateSummary !== undefined) {
    updates.push("state_summary = ?");
    values.push(body.stateSummary);
  }
  if (body.stateRaw !== undefined) {
    updates.push("state_raw = ?");
    values.push(body.stateRaw);
  }

  if (updates.length === 0) {
    return c.json(toSession(existing));
  }

  values.push(sessionId);
  await c.env.DB.prepare(
    `UPDATE app_sessions SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare(
    "SELECT id, conversation_id, app_id, status, state_summary, state_raw, started_at, completed_at FROM app_sessions WHERE id = ?",
  )
    .bind(sessionId)
    .first<DbSessionRow>();

  return c.json(toSession(updated!));
});

export default appSessions;
