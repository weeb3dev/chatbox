import { Hono } from "hono";
import type { Env } from "../../types";
import { verifyJWT } from "../lib/crypto";
import {
  HEADER_CHAT_CONVERSATION,
  HEADER_CHAT_USER,
} from "../chat-session";

const ws = new Hono<{ Bindings: Env }>();

/** WebSocket upgrade: JWT in ?token= (browser cannot send Authorization on WS handshake). */
ws.get("/chat/:conversationId", async (c) => {
  const conversationId = c.req.param("conversationId");
  const token = new URL(c.req.url).searchParams.get("token");
  if (!token) {
    return c.json({ error: "Missing token query parameter" }, 403);
  }

  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 403);
  }

  const conv = await c.env.DB.prepare(
    "SELECT user_id FROM conversations WHERE id = ?",
  )
    .bind(conversationId)
    .first<{ user_id: string }>();

  if (!conv) {
    return c.json({ error: "Conversation not found" }, 404);
  }
  if (conv.user_id !== payload.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const id = c.env.CHAT_SESSION.idFromName(conversationId);
  const stub = c.env.CHAT_SESSION.get(id);

  const headers = new Headers(c.req.raw.headers);
  headers.set(HEADER_CHAT_USER, payload.userId);
  headers.set(HEADER_CHAT_CONVERSATION, conversationId);

  return stub.fetch(
    new Request(c.req.url, {
      method: "GET",
      headers,
    }),
  );
});

export default ws;
