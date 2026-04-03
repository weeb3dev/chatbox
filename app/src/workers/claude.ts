import type {
  Env,
  AppManifest,
  AppSession,
  Message,
} from "../types";

// ── Claude API types ────────────────────────────────────────────────────

interface ClaudeTextBlock {
  type: "text";
  text: string;
}

interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock;

interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | (ClaudeContentBlock | ClaudeToolResultBlock)[];
}

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface CallClaudeParams {
  env: Env;
  system: string;
  messages: ClaudeMessage[];
  tools: ClaudeTool[];
  userId: string;
  appId?: string;
}

// ── callClaude ──────────────────────────────────────────────────────────

export async function callClaude(params: CallClaudeParams): Promise<Response> {
  const { env, system, messages, tools, userId, appId } = params;
  const url = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic/v1/messages`;

  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system,
    messages,
    stream: true,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  return fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      "cf-aig-metadata": JSON.stringify({
        userId,
        appId: appId ?? "none",
        hasToolSchemas: tools.length > 0,
      }),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/** Up to 3 attempts with 1s / 2s / 4s backoff before retries 2 and 3. */
export async function callClaudeWithRetry(
  params: CallClaudeParams,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await callClaude(params);
      if (res.ok) return res;
      const status = res.status;
      if (status === 429 || status >= 500) {
        if (attempt < 2) {
          console.warn(
            `[ChatBridge] Claude request retry after ${status} (attempt ${attempt + 1}/3)`,
          );
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
      }
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < 2) {
        console.warn(
          `[ChatBridge] Claude fetch failed, retry (attempt ${attempt + 1}/3):`,
          e,
        );
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Claude request failed after retries");
}

// ── buildSystemPrompt ───────────────────────────────────────────────────

interface AppSummary {
  name: string;
  description: string;
}

export function buildSystemPrompt(
  availableApps: AppSummary[],
  appSessions: AppSession[],
): string {
  const sections: string[] = [];

  sections.push(`You are a helpful AI assistant in the ChatBridge platform — an educational chat environment where third-party mini-apps can run inside the conversation.

Your capabilities:
- Answer questions and have natural conversations
- Discover and invoke third-party apps when the user wants to use them
- Interact with active apps on behalf of the user (make moves, query state, etc.)

Rules:
- When the user's request could match multiple apps, ask one short clarifying question before calling any app tool. Do not guess.
- When the user asks to use an app or their request clearly matches a single app's purpose, call list_available_apps only if you need schemas or are unsure which tool to use; then invoke the correct app tool.
- When an app session is already active, prefer that app's tools for ambiguous follow-ups (e.g. mid-game advice belongs to the active game app).
- When the user's request doesn't match any available app, answer directly without invoking tools.
- When the user asks to stop or switch apps (e.g. end the game and open weather), complete or close the current app flow as appropriate, then start the new app—do not mix tools from unrelated apps in one turn.
- When an app signals completion, acknowledge the result naturally and continue the conversation.
- Never fabricate tool results. If a tool call fails, explain the error honestly.
- If an app or tool times out or errors, acknowledge it briefly, offer to try again or do something else, and keep the conversation helpful.
- Keep responses concise and helpful.

Examples (behavior to follow):
- User: "let's play chess" → Start chess (clear match).
- User: "what's the weather in Austin?" → Start weather (clear match).
- User: "show me something fun" → Ask which app they want (ambiguous).
- User: "what's 2+2?" → Answer "4" with no tools.
- Active chess session, user: "what should I do?" → Use chess tools to analyze; do not call weather.
- User: "stop chess and check the weather" → End chess session appropriately, then open weather.`);

  if (appSessions.length > 0) {
    const sessionLines = appSessions.map((s) => {
      const summary = s.stateSummary ?? "No state summary available";
      return `- App "${s.appId}" is active. Current state: ${summary}`;
    });
    sections.push(
      `Active app sessions:\n${sessionLines.join("\n")}`,
    );
  }

  if (availableApps.length > 0) {
    const appLines = availableApps.map(
      (a) => `- ${a.name}: ${a.description}`,
    );
    sections.push(
      `Available apps (call list_available_apps for full details):\n${appLines.join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

// ── buildToolArray ──────────────────────────────────────────────────────

const LIST_APPS_TOOL: ClaudeTool = {
  name: "list_available_apps",
  description:
    "List registered third-party apps and their tool schemas. Call only when you need discovery (user wants an app but intent is unclear, or you need exact tool names/parameters). Do not call on every turn if you already know which app and tool to use.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Optional search query to filter apps by name or description",
      },
    },
  },
};

export function buildToolArray(
  activeAppManifests: AppManifest[],
): ClaudeTool[] {
  const tools: ClaudeTool[] = [LIST_APPS_TOOL];

  for (const manifest of activeAppManifests) {
    for (const tool of manifest.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: "object",
          properties: tool.parameters.properties as Record<string, unknown>,
          required: tool.parameters.required,
        },
      });
    }
  }

  return tools;
}

// ── Reverse lookup: tool name → appId ───────────────────────────────────

export function buildToolToAppMap(
  manifests: AppManifest[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      map.set(tool.name, manifest.id);
    }
  }
  return map;
}

// ── convertMessageHistory ───────────────────────────────────────────────

export function convertMessageHistory(dbMessages: Message[]): ClaudeMessage[] {
  const claudeMessages: ClaudeMessage[] = [];
  const seenToolResultIds = new Set<string>();

  for (let i = 0; i < dbMessages.length; i++) {
    const msg = dbMessages[i];

    if (msg.role === "user") {
      claudeMessages.push({ role: "user", content: msg.content ?? "" });
    } else if (msg.role === "assistant") {
      const contentBlocks: ClaudeContentBlock[] = [];
      if (msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }

      while (i + 1 < dbMessages.length && dbMessages[i + 1].role === "tool_call") {
        i++;
        const tc = dbMessages[i];
        contentBlocks.push({
          type: "tool_use",
          id: tc.content ?? tc.id,
          name: tc.toolName ?? "unknown",
          input: tc.toolParams ? JSON.parse(tc.toolParams) : {},
        });
      }

      claudeMessages.push({ role: "assistant", content: contentBlocks });
    } else if (msg.role === "tool_result") {
      const toolUseId = msg.toolParams ?? msg.id;

      if (seenToolResultIds.has(toolUseId)) continue;
      seenToolResultIds.add(toolUseId);

      const resultContent = msg.toolResult
        ? (() => {
            try {
              const parsed = JSON.parse(msg.toolResult);
              return parsed.displayText ?? JSON.stringify(parsed);
            } catch {
              return msg.toolResult;
            }
          })()
        : "No result";

      const block: ClaudeToolResultBlock = {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: resultContent,
      };

      const last = claudeMessages[claudeMessages.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        (last.content as ClaudeToolResultBlock[]).every(
          (b) => (b as { type: string }).type === "tool_result",
        )
      ) {
        (last.content as ClaudeToolResultBlock[]).push(block);
      } else {
        claudeMessages.push({ role: "user", content: [block] });
      }
    }
  }

  return claudeMessages;
}
