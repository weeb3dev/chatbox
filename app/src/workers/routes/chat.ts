import { Hono } from "hono";
import type { Env, Message, AppManifest, AppSession, ServerMessage } from "../../types";
import {
  callClaudeWithRetry,
  buildSystemPrompt,
  buildToolArray,
  buildToolToAppMap,
  convertMessageHistory,
} from "../claude";
import { formatSSEEvent, createSSEResponse } from "../lib/sse";

type ChatApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const chat = new Hono<ChatApp>();

// ── DB row types ────────────────────────────────────────────────────────

interface DbMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_params: string | null;
  tool_result: string | null;
  app_id: string | null;
  sequence_num: number;
  created_at: string;
}

interface DbAppRow {
  id: string;
  name: string;
  slug: string;
  manifest_json: string;
  status: string;
  entry_url: string;
  auth_type: string;
}

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

function dbRowToMessage(row: DbMessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Message["role"],
    content: row.content,
    toolName: row.tool_name,
    toolParams: row.tool_params,
    toolResult: row.tool_result,
    appId: row.app_id,
    sequenceNum: row.sequence_num,
    createdAt: row.created_at,
  };
}

// ── Stream parsing types ────────────────────────────────────────────────

interface ToolUseAccumulator {
  id: string;
  name: string;
  inputJson: string;
}

interface StreamResult {
  assistantText: string;
  toolUseBlocks: ToolUseAccumulator[];
  stopReason: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function processOneClaudeStream(
  claudeResponse: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
): Promise<StreamResult> {
  const result: StreamResult = {
    assistantText: "",
    toolUseBlocks: [],
    stopReason: "end_turn",
  };

  let currentToolUse: ToolUseAccumulator | null = null;
  let sseBuffer = "";

  const reader = claudeResponse.body!.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      const parts = sseBuffer.split("\n\n");
      sseBuffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        const lines = part.split("\n");
        let eventType = "";
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }

        if (!eventType || !dataStr) continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        switch (eventType) {
          case "content_block_start": {
            const block = data.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              currentToolUse = {
                id: block.id as string,
                name: block.name as string,
                inputJson: "",
              };
            }
            break;
          }

          case "content_block_delta": {
            const delta = data.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") {
              const text = delta.text as string;
              result.assistantText += text;
              const event: ServerMessage = {
                type: "assistant_chunk",
                content: text,
              };
              await writer.write(encoder.encode(formatSSEEvent(event)));
            } else if (delta?.type === "input_json_delta" && currentToolUse) {
              currentToolUse.inputJson += delta.partial_json as string;
            }
            break;
          }

          case "content_block_stop": {
            if (currentToolUse) {
              result.toolUseBlocks.push(currentToolUse);
              currentToolUse = null;
            }
            break;
          }

          case "message_delta": {
            const delta = data.delta as Record<string, unknown>;
            if (delta?.stop_reason) {
              result.stopReason = delta.stop_reason as string;
            }
            break;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return result;
}

interface ChatContext {
  messages: Message[];
  appSessions: AppSession[];
  approvedApps: DbAppRow[];
  activeManifests: AppManifest[];
}

async function loadChatContext(
  db: D1Database,
  kv: KVNamespace,
  conversationId: string,
): Promise<ChatContext> {
  const [messagesResult, sessionsResult, appsResult] = await Promise.all([
    db
      .prepare(
        "SELECT id, conversation_id, role, content, tool_name, tool_params, tool_result, app_id, sequence_num, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence_num",
      )
      .bind(conversationId)
      .all<DbMessageRow>(),
    db
      .prepare(
        "SELECT id, conversation_id, app_id, status, state_summary, state_raw, started_at, completed_at FROM app_sessions WHERE conversation_id = ? AND status = 'active'",
      )
      .bind(conversationId)
      .all<DbSessionRow>(),
    db
      .prepare(
        "SELECT id, name, slug, manifest_json, status, entry_url, auth_type FROM apps WHERE status = 'approved'",
      )
      .all<DbAppRow>(),
  ]);

  const appSessions: AppSession[] = sessionsResult.results.map((s) => ({
    id: s.id,
    conversationId: s.conversation_id,
    appId: s.app_id,
    status: s.status as AppSession["status"],
    stateSummary: s.state_summary,
    stateRaw: s.state_raw,
    startedAt: s.started_at,
    completedAt: s.completed_at,
  }));

  const activeAppIds = new Set(appSessions.map((s) => s.appId));
  const manifestPromises = [...activeAppIds].map((appId) =>
    kv.get<AppManifest>(`app:${appId}`, "json"),
  );
  const manifestResults = await Promise.all(manifestPromises);
  const activeManifests = manifestResults.filter(
    (m): m is AppManifest => m !== null,
  );

  return {
    messages: messagesResult.results.map(dbRowToMessage),
    appSessions,
    approvedApps: appsResult.results,
    activeManifests,
  };
}

async function getNextSeqNum(
  db: D1Database,
  conversationId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT MAX(sequence_num) as max_seq FROM messages WHERE conversation_id = ?",
    )
    .bind(conversationId)
    .first<{ max_seq: number | null }>();
  return (row?.max_seq ?? -1) + 1;
}

async function saveMessage(
  db: D1Database,
  params: {
    conversationId: string;
    role: string;
    content?: string | null;
    toolName?: string | null;
    toolParams?: string | null;
    toolResult?: string | null;
    appId?: string | null;
    seqNum: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO messages (id, conversation_id, role, content, tool_name, tool_params, tool_result, app_id, sequence_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      params.conversationId,
      params.role,
      params.content ?? null,
      params.toolName ?? null,
      params.toolParams ?? null,
      params.toolResult ?? null,
      params.appId ?? null,
      params.seqNum,
    )
    .run();
  return id;
}

async function reloadMessages(
  db: D1Database,
  conversationId: string,
): Promise<Message[]> {
  const { results } = await db
    .prepare(
      "SELECT id, conversation_id, role, content, tool_name, tool_params, tool_result, app_id, sequence_num, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence_num",
    )
    .bind(conversationId)
    .all<DbMessageRow>();
  return results.map(dbRowToMessage);
}

// Shared streaming pipeline used by both endpoints.
// Handles the list_available_apps recursive loop, saves messages, and
// sends tool_invoke / assistant_done events to the client.
async function handleChatStream(params: {
  env: Env;
  userId: string;
  conversationId: string;
  initialMessages: Message[];
  appSessions: AppSession[];
  approvedApps: DbAppRow[];
  activeManifests: AppManifest[];
  seqNum: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
}): Promise<void> {
  const {
    env,
    userId,
    conversationId,
    initialMessages,
    appSessions,
    approvedApps,
    activeManifests,
    writer,
    encoder,
  } = params;
  let { seqNum } = params;

  const availableAppSummaries = approvedApps.map((a) => {
    try {
      const manifest = JSON.parse(a.manifest_json) as AppManifest;
      return { name: a.name, description: manifest.description };
    } catch {
      return { name: a.name, description: "" };
    }
  });

  let currentManifests = activeManifests;
  let currentToolToAppMap = buildToolToAppMap(currentManifests);
  const maxIterations = 3;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const messages =
      iteration === 0
        ? initialMessages
        : await reloadMessages(env.DB, conversationId);

    const systemPrompt = buildSystemPrompt(availableAppSummaries, appSessions);
    const tools = buildToolArray(currentManifests);
    const claudeMessages = convertMessageHistory(messages);

    let claudeResponse: Response;
    try {
      claudeResponse = await callClaudeWithRetry({
        env,
        system: systemPrompt,
        messages: claudeMessages,
        tools,
        userId,
      });
    } catch (e) {
      console.error("Claude API failed after retries:", e);
      const errEvent: ServerMessage = {
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      };
      await writer.write(encoder.encode(formatSSEEvent(errEvent)));
      return;
    }

    if (!claudeResponse.ok) {
      const errBody = await claudeResponse.text().catch(() => "Unknown error");
      console.error("Claude API error:", claudeResponse.status, errBody);
      const errEvent: ServerMessage = {
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      };
      await writer.write(encoder.encode(formatSSEEvent(errEvent)));
      return;
    }

    const streamResult = await processOneClaudeStream(
      claudeResponse,
      writer,
      encoder,
    );

    // Save assistant message
    const assistantMsgId = await saveMessage(env.DB, {
      conversationId,
      role: "assistant",
      content: streamResult.assistantText || null,
      seqNum: seqNum++,
    });

    // Save tool_call messages — store Claude's tool_use_id in `content`
    for (const toolUse of streamResult.toolUseBlocks) {
      const appId = currentToolToAppMap.get(toolUse.name) ?? null;
      await saveMessage(env.DB, {
        conversationId,
        role: "tool_call",
        content: toolUse.id,
        toolName: toolUse.name,
        toolParams: toolUse.inputJson || "{}",
        appId,
        seqNum: seqNum++,
      });
    }

    // Partition tool calls
    const listAppsCalls = streamResult.toolUseBlocks.filter(
      (t) => t.name === "list_available_apps",
    );
    const appToolCalls = streamResult.toolUseBlocks.filter(
      (t) => t.name !== "list_available_apps",
    );

    if (listAppsCalls.length > 0) {
      // Handle list_available_apps server-side: save result, load all
      // manifests, then loop to call Claude again.
      const appListData = approvedApps.map((a) => {
        try {
          const manifest = JSON.parse(a.manifest_json) as AppManifest;
          return {
            id: a.id,
            name: a.name,
            description: manifest.description,
            category: manifest.category,
            tools: manifest.tools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
          };
        } catch {
          return { id: a.id, name: a.name, description: "", category: "", tools: [] as { name: string; description: string }[] };
        }
      });

      for (const listCall of listAppsCalls) {
        await saveMessage(env.DB, {
          conversationId,
          role: "tool_result",
          toolParams: listCall.id,
          toolResult: JSON.stringify({
            success: true,
            data: appListData,
            displayText: `Found ${appListData.length} available app(s): ${appListData.map((a) => a.name).join(", ")}`,
          }),
          seqNum: seqNum++,
        });
      }

      // Inject ALL app tools for the next iteration
      const allManifestPromises = approvedApps.map((a) =>
        env.APP_MANIFESTS.get<AppManifest>(`app:${a.id}`, "json"),
      );
      const allManifests = (await Promise.all(allManifestPromises)).filter(
        (m): m is AppManifest => m !== null,
      );

      // Fallback: parse from DB if KV is empty
      if (allManifests.length === 0) {
        for (const a of approvedApps) {
          try {
            allManifests.push(JSON.parse(a.manifest_json) as AppManifest);
          } catch {
            /* skip */
          }
        }
      }

      currentManifests = allManifests;
      currentToolToAppMap = buildToolToAppMap(allManifests);
      continue;
    }

    // Forward app tool invocations to the client
    if (appToolCalls.length > 0) {
      for (const toolUse of appToolCalls) {
        const appId = currentToolToAppMap.get(toolUse.name) ?? "unknown";
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(toolUse.inputJson || "{}");
        } catch {
          parsedInput = {};
        }

        const invokeEvent: ServerMessage = {
          type: "tool_invoke",
          callId: toolUse.id,
          appId,
          tool: toolUse.name,
          params: parsedInput,
        };
        await writer.write(encoder.encode(formatSSEEvent(invokeEvent)));
      }
    }

    const doneEvent: ServerMessage = {
      type: "assistant_done",
      messageId: assistantMsgId,
    };
    await writer.write(encoder.encode(formatSSEEvent(doneEvent)));
    return;
  }
}

// ── POST / ──────────────────────────────────────────────────────────────

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

  const streamPromise = handleChatStream({
    env: c.env,
    userId,
    conversationId,
    initialMessages: ctx.messages,
    appSessions: ctx.appSessions,
    approvedApps: ctx.approvedApps,
    activeManifests: ctx.activeManifests,
    seqNum,
    writer,
    encoder,
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

// ── POST /tool-result ───────────────────────────────────────────────────

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

  const streamPromise = handleChatStream({
    env: c.env,
    userId,
    conversationId,
    initialMessages: ctx.messages,
    appSessions: ctx.appSessions,
    approvedApps: ctx.approvedApps,
    activeManifests: ctx.activeManifests,
    seqNum,
    writer,
    encoder,
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
