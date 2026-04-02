import type { Env, Message, AppManifest, AppSession, ServerMessage } from "../../types";
import {
  callClaudeWithRetry,
  buildSystemPrompt,
  buildToolArray,
  buildToolToAppMap,
  convertMessageHistory,
} from "../claude";

/** Emit one server→client message (SSE or WebSocket JSON). */
export type EmitServerMessage = (msg: ServerMessage) => Promise<void>;

// ── DB row types ────────────────────────────────────────────────────────

export interface DbMessageRow {
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

export interface DbAppRow {
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

export function dbRowToMessage(row: DbMessageRow): Message {
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

export async function processOneClaudeStream(
  claudeResponse: Response,
  emit: EmitServerMessage,
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
              await emit({
                type: "assistant_chunk",
                content: text,
              });
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

export interface ChatContext {
  messages: Message[];
  appSessions: AppSession[];
  approvedApps: DbAppRow[];
  activeManifests: AppManifest[];
}

export async function loadChatContext(
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

export async function getNextSeqNum(
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

export async function saveMessage(
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

export async function reloadMessages(
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

/** Fired after each row is inserted into D1 (for DO SQLite mirror, analytics, etc.). */
export type MessageSavedHook = (row: {
  id: string;
  conversationId: string;
  role: string;
  content: string | null;
  toolName: string | null;
  toolParams: string | null;
  toolResult: string | null;
  appId: string | null;
  seqNum: number;
}) => Promise<void>;

/** Shared Claude loop: D1 persistence + tool_invoke / assistant_done / error via emit. */
export async function handleChatStream(params: {
  env: Env;
  userId: string;
  conversationId: string;
  initialMessages: Message[];
  appSessions: AppSession[];
  approvedApps: DbAppRow[];
  activeManifests: AppManifest[];
  seqNum: number;
  emit: EmitServerMessage;
  onMessageSaved?: MessageSavedHook;
}): Promise<void> {
  const {
    env,
    userId,
    conversationId,
    initialMessages,
    appSessions,
    approvedApps,
    activeManifests,
    emit,
    onMessageSaved,
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
      await emit({
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      });
      return;
    }

    if (!claudeResponse.ok) {
      const errBody = await claudeResponse.text().catch(() => "Unknown error");
      console.error("Claude API error:", claudeResponse.status, errBody);
      await emit({
        type: "error",
        message: "Something went wrong. Try again.",
        retryable: true,
      });
      return;
    }

    const streamResult = await processOneClaudeStream(claudeResponse, emit);

    const assistantSeq = seqNum++;
    const assistantMsgId = await saveMessage(env.DB, {
      conversationId,
      role: "assistant",
      content: streamResult.assistantText || null,
      seqNum: assistantSeq,
    });
    await onMessageSaved?.({
      id: assistantMsgId,
      conversationId,
      role: "assistant",
      content: streamResult.assistantText || null,
      toolName: null,
      toolParams: null,
      toolResult: null,
      appId: null,
      seqNum: assistantSeq,
    });

    for (const toolUse of streamResult.toolUseBlocks) {
      const appId = currentToolToAppMap.get(toolUse.name) ?? null;
      const tcSeq = seqNum++;
      const tcId = await saveMessage(env.DB, {
        conversationId,
        role: "tool_call",
        content: toolUse.id,
        toolName: toolUse.name,
        toolParams: toolUse.inputJson || "{}",
        appId,
        seqNum: tcSeq,
      });
      await onMessageSaved?.({
        id: tcId,
        conversationId,
        role: "tool_call",
        content: toolUse.id,
        toolName: toolUse.name,
        toolParams: toolUse.inputJson || "{}",
        toolResult: null,
        appId,
        seqNum: tcSeq,
      });
    }

    const listAppsCalls = streamResult.toolUseBlocks.filter(
      (t) => t.name === "list_available_apps",
    );
    const appToolCalls = streamResult.toolUseBlocks.filter(
      (t) => t.name !== "list_available_apps",
    );

    if (listAppsCalls.length > 0) {
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
          return {
            id: a.id,
            name: a.name,
            description: "",
            category: "",
            tools: [] as { name: string; description: string }[],
          };
        }
      });

      for (const listCall of listAppsCalls) {
        const trSeq = seqNum++;
        const trResult = JSON.stringify({
          success: true,
          data: appListData,
          displayText: `Found ${appListData.length} available app(s): ${appListData.map((a) => a.name).join(", ")}`,
        });
        const trId = await saveMessage(env.DB, {
          conversationId,
          role: "tool_result",
          toolParams: listCall.id,
          toolResult: trResult,
          seqNum: trSeq,
        });
        await onMessageSaved?.({
          id: trId,
          conversationId,
          role: "tool_result",
          content: null,
          toolName: null,
          toolParams: listCall.id,
          toolResult: trResult,
          appId: null,
          seqNum: trSeq,
        });
      }

      const allManifestPromises = approvedApps.map((a) =>
        env.APP_MANIFESTS.get<AppManifest>(`app:${a.id}`, "json"),
      );
      const allManifests = (await Promise.all(allManifestPromises)).filter(
        (m): m is AppManifest => m !== null,
      );

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

    if (appToolCalls.length > 0) {
      for (const toolUse of appToolCalls) {
        const appId = currentToolToAppMap.get(toolUse.name) ?? "unknown";
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(toolUse.inputJson || "{}");
        } catch {
          parsedInput = {};
        }

        await emit({
          type: "tool_invoke",
          callId: toolUse.id,
          appId,
          tool: toolUse.name,
          params: parsedInput,
        });
      }
    }

    await emit({
      type: "assistant_done",
      messageId: assistantMsgId,
    });
    return;
  }
}
