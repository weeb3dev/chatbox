import { Hono } from "hono";
import type { Env, ServerMessage } from "../../types";
import { formatSSEEvent, createSSEResponse } from "../lib/sse";
import {
  loadChatContext,
  getNextSeqNum,
  saveMessage,
  handleChatStream,
} from "../lib/chat-pipeline";

type ChatApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const chat = new Hono<ChatApp>();

chat.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ conversationId: string; content: string }>();
  const { conversationId, content } = body;

  if (!conversationId || !content) {
    return c.json({ error: "conversationId and content are required" }, 400);
  }

  const conv = await c.env.DB.prepare(
    "SELECT user_id FROM conversations WHERE id = ?",
  )
    .bind(conversationId)
    .first<{ user_id: string }>();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  if (conv.user_id !== userId) return c.json({ error: "Forbidden" }, 403);

  let seqNum = await getNextSeqNum(c.env.DB, conversationId);
  await saveMessage(c.env.DB, {
    conversationId,
    role: "user",
    content,
    seqNum: seqNum++,
  });

  await c.env.DB.prepare(
    "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
  )
    .bind(conversationId)
    .run();

  const ctx = await loadChatContext(c.env.DB, c.env.APP_MANIFESTS, conversationId);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const emit = async (msg: ServerMessage) => {
    await writer.write(encoder.encode(formatSSEEvent(msg)));
  };

  const streamPromise = handleChatStream({
    env: c.env,
    userId,
    conversationId,
    initialMessages: ctx.messages,
    appSessions: ctx.appSessions,
    approvedApps: ctx.approvedApps,
    activeManifests: ctx.activeManifests,
    seqNum,
    emit,
  });

  streamPromise
    .catch((err) => {
      console.error("Stream processing error:", err);
      const errEvent: ServerMessage = {
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      };
      return writer.write(encoder.encode(formatSSEEvent(errEvent)));
    })
    .finally(() => writer.close().catch(() => {}));

  return createSSEResponse(readable);
});

chat.post("/tool-result", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    conversationId: string;
    callId: string;
    result: { success: boolean; data?: unknown; error?: string; displayText?: string };
  }>();
  const { conversationId, callId, result } = body;

  if (!conversationId || !callId || !result) {
    return c.json(
      { error: "conversationId, callId, and result are required" },
      400,
    );
  }

  const conv = await c.env.DB.prepare(
    "SELECT user_id FROM conversations WHERE id = ?",
  )
    .bind(conversationId)
    .first<{ user_id: string }>();

  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  if (conv.user_id !== userId) return c.json({ error: "Forbidden" }, 403);

  let seqNum = await getNextSeqNum(c.env.DB, conversationId);
  await saveMessage(c.env.DB, {
    conversationId,
    role: "tool_result",
    toolParams: callId,
    toolResult: JSON.stringify(result),
    seqNum: seqNum++,
  });

  const ctx = await loadChatContext(c.env.DB, c.env.APP_MANIFESTS, conversationId);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const emit = async (msg: ServerMessage) => {
    await writer.write(encoder.encode(formatSSEEvent(msg)));
  };

  const streamPromise = handleChatStream({
    env: c.env,
    userId,
    conversationId,
    initialMessages: ctx.messages,
    appSessions: ctx.appSessions,
    approvedApps: ctx.approvedApps,
    activeManifests: ctx.activeManifests,
    seqNum,
    emit,
  });

  streamPromise
    .catch((err) => {
      console.error("Stream processing error:", err);
      const errEvent: ServerMessage = {
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      };
      return writer.write(encoder.encode(formatSSEEvent(errEvent)));
    })
    .finally(() => writer.close().catch(() => {}));

  return createSSEResponse(readable);
});

export default chat;
