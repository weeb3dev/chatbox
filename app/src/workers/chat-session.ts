import { DurableObject } from "cloudflare:workers";
import type { Env, ClientMessage, ServerMessage, ToolResult } from "../types";
import {
  loadChatContext,
  getNextSeqNum,
  saveMessage,
  handleChatStream,
  type MessageSavedHook,
  type DbMessageRow,
} from "./lib/chat-pipeline";

/** Set by Worker after JWT + conversation checks; never trust client WebSocket frames for identity. */
export const HEADER_CHAT_USER = "X-ChatBridge-UserId";
export const HEADER_CHAT_CONVERSATION = "X-ChatBridge-Conversation-Id";

/**
 * Chat session DO: hibernatable WebSockets, D1 as source of truth, SQLite mirror for eviction/wake.
 * Multiple tabs: all sockets receive the same broadcast stream (assistant chunks, tool_invoke, etc.).
 */
export class ChatSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS session_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          tool_name TEXT,
          tool_params TEXT,
          tool_result TEXT,
          app_id TEXT,
          sequence_num INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT ''
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_apps (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          status TEXT,
          state_summary TEXT,
          state_raw TEXT,
          started_at TEXT,
          completed_at TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pending_tool_calls (
          call_id TEXT PRIMARY KEY,
          tool_name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    });
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  private getMeta(key: string): string | null {
    const cur = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?",
      key,
    );
    const row = cur.toArray()[0];
    return row?.value ?? null;
  }

  /** Mirror a D1 message row into DO SQLite (INSERT OR REPLACE). */
  private mirrorMessageRow(row: {
    id: string;
    conversationId: string;
    role: string;
    content: string | null;
    toolName: string | null;
    toolParams: string | null;
    toolResult: string | null;
    appId: string | null;
    seqNum: number;
    createdAt: string;
  }): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO session_messages
        (id, conversation_id, role, content, tool_name, tool_params, tool_result, app_id, sequence_num, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.conversationId,
      row.role,
      row.content,
      row.toolName,
      row.toolParams,
      row.toolResult,
      row.appId,
      row.seqNum,
      row.createdAt,
    );
  }

  private onMessageSavedMirror: MessageSavedHook = async (row) => {
    this.mirrorMessageRow({
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      toolName: row.toolName,
      toolParams: row.toolParams,
      toolResult: row.toolResult,
      appId: row.appId,
      seqNum: row.seqNum,
      createdAt: "",
    });
  };

  private async syncActiveAppsFromD1(conversationId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM active_apps WHERE conversation_id = ?",
      conversationId,
    );
    const { results } = await this.env.DB.prepare(
      "SELECT id, conversation_id, app_id, status, state_summary, state_raw, started_at, completed_at FROM app_sessions WHERE conversation_id = ? AND status = 'active'",
    )
      .bind(conversationId)
      .all<{
        id: string;
        conversation_id: string;
        app_id: string;
        status: string;
        state_summary: string | null;
        state_raw: string | null;
        started_at: string;
        completed_at: string | null;
      }>();

    for (const r of results) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO active_apps
          (id, conversation_id, app_id, status, state_summary, state_raw, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id,
        r.conversation_id,
        r.app_id,
        r.status,
        r.state_summary,
        r.state_raw,
        r.started_at,
        r.completed_at,
      );
    }
  }

  /** If SQLite has no rows for this conversation, hydrate from D1. */
  private async ensureSessionCache(conversationId: string): Promise<void> {
    const countCur = this.ctx.storage.sql.exec<{ c: number }>(
      "SELECT COUNT(*) as c FROM session_messages WHERE conversation_id = ?",
      conversationId,
    );
    const count = countCur.toArray()[0]?.c ?? 0;
    if (count > 0) return;

    const { results } = await this.env.DB.prepare(
      "SELECT id, conversation_id, role, content, tool_name, tool_params, tool_result, app_id, sequence_num, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence_num",
    )
      .bind(conversationId)
      .all<DbMessageRow>();

    for (const row of results) {
      this.mirrorMessageRow({
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        toolName: row.tool_name,
        toolParams: row.tool_params,
        toolResult: row.tool_result,
        appId: row.app_id,
        seqNum: row.sequence_num,
        createdAt: row.created_at,
      });
    }

    await this.syncActiveAppsFromD1(conversationId);
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* closed */
      }
    }
  }

  private emitWithPending: (msg: ServerMessage) => Promise<void> = async (
    msg,
  ) => {
    if (msg.type === "tool_invoke") {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO pending_tool_calls (call_id, tool_name, created_at) VALUES (?, ?, ?)",
        msg.callId,
        msg.tool,
        Date.now(),
      );
    }
    this.broadcast(msg);
  };

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket Upgrade", { status: 426 });
    }

    const userId = request.headers.get(HEADER_CHAT_USER);
    const conversationId = request.headers.get(HEADER_CHAT_CONVERSATION);
    if (!userId || !conversationId) {
      return new Response("Missing session headers", { status: 400 });
    }

    this.setMeta("user_id", userId);
    this.setMeta("conversation_id", conversationId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const conversationId = this.getMeta("conversation_id");
    const userId = this.getMeta("user_id");
    if (!conversationId || !userId) {
      ws.close(4000, "Session not initialized");
      return;
    }

    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return;
    }

    const clientMsg = parsed as ClientMessage;

    try {
      if (clientMsg.type === "user_message") {
        const content =
          typeof clientMsg.content === "string" ? clientMsg.content : "";
        if (!content.trim()) return;

        await this.ensureSessionCache(conversationId);

        let seqNum = await getNextSeqNum(this.env.DB, conversationId);
        const uSeq = seqNum++;
        const userMsgId = await saveMessage(this.env.DB, {
          conversationId,
          role: "user",
          content,
          seqNum: uSeq,
        });
        this.mirrorMessageRow({
          id: userMsgId,
          conversationId,
          role: "user",
          content,
          toolName: null,
          toolParams: null,
          toolResult: null,
          appId: null,
          seqNum: uSeq,
          createdAt: "",
        });

        await this.env.DB.prepare(
          "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
        )
          .bind(conversationId)
          .run();

        await this.syncActiveAppsFromD1(conversationId);

        const ctx = await loadChatContext(
          this.env.DB,
          this.env.APP_MANIFESTS,
          conversationId,
        );

        await handleChatStream({
          env: this.env,
          userId,
          conversationId,
          initialMessages: ctx.messages,
          appSessions: ctx.appSessions,
          approvedApps: ctx.approvedApps,
          activeManifests: ctx.activeManifests,
          seqNum,
          emit: this.emitWithPending,
          onMessageSaved: this.onMessageSavedMirror,
        });
        return;
      }

      if (clientMsg.type === "tool_result") {
        const callId =
          typeof clientMsg.callId === "string" ? clientMsg.callId : "";
        const result = clientMsg.result as ToolResult;
        if (!callId || !result) return;

        const existing = await this.env.DB.prepare(
          "SELECT id FROM messages WHERE conversation_id = ? AND role = 'tool_result' AND tool_params = ?",
        )
          .bind(conversationId, callId)
          .first<{ id: string }>();
        if (existing) return;

        this.ctx.storage.sql.exec(
          "DELETE FROM pending_tool_calls WHERE call_id = ?",
          callId,
        );

        await this.ensureSessionCache(conversationId);

        let seqNum = await getNextSeqNum(this.env.DB, conversationId);
        const trSeq = seqNum++;
        const trId = await saveMessage(this.env.DB, {
          conversationId,
          role: "tool_result",
          toolParams: callId,
          toolResult: JSON.stringify(result),
          seqNum: trSeq,
        });
        this.mirrorMessageRow({
          id: trId,
          conversationId,
          role: "tool_result",
          content: null,
          toolName: null,
          toolParams: callId,
          toolResult: JSON.stringify(result),
          appId: null,
          seqNum: trSeq,
          createdAt: "",
        });

        await this.syncActiveAppsFromD1(conversationId);

        const ctx = await loadChatContext(
          this.env.DB,
          this.env.APP_MANIFESTS,
          conversationId,
        );

        await handleChatStream({
          env: this.env,
          userId,
          conversationId,
          initialMessages: ctx.messages,
          appSessions: ctx.appSessions,
          approvedApps: ctx.approvedApps,
          activeManifests: ctx.activeManifests,
          seqNum,
          emit: this.emitWithPending,
          onMessageSaved: this.onMessageSavedMirror,
        });
      }
    } catch (e) {
      console.error("ChatSession webSocketMessage error:", e);
      const err: ServerMessage = {
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      };
      this.broadcast(err);
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void ws;
    void code;
    void reason;
    void wasClean;
    // Hibernation-safe: no async work required; pending_tool_calls remain until tool_result or timeout.
  }

  webSocketError(_ws: WebSocket, err: unknown): void {
    console.error("ChatSession webSocketError:", err);
  }
}
