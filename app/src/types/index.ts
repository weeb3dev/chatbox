// ── Data model types (mirrors D1 schema) ──────────────────────────────

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface App {
  id: string;
  name: string;
  slug: string;
  manifest: AppManifest;
  status: "pending" | "approved" | "rejected" | "suspended";
  entryUrl: string;
  authType: "none" | "api_key" | "oauth2";
  createdAt: string;
  approvedAt: string | null;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system";

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string | null;
  toolName: string | null;
  toolParams: string | null;
  toolResult: string | null;
  appId: string | null;
  sequenceNum: number;
  createdAt: string;
}

export interface AppSession {
  id: string;
  conversationId: string;
  appId: string;
  status: "active" | "completed" | "error" | "timeout";
  stateSummary: string | null;
  stateRaw: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AppToken {
  id: string;
  userId: string;
  appId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  scopes: string | null;
  expiresAt: string;
  createdAt: string;
}

// ── App manifest schema (PRD §4.1) ────────────────────────────────────

export interface AppManifestIframe {
  width: string;
  height: string;
  sandbox: string[];
}

export interface AppManifestToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  default?: string;
}

export interface AppManifestToolSchema {
  type: "object";
  properties: Record<string, AppManifestToolParameter>;
  required?: string[];
}

export interface AppManifestTool {
  name: string;
  description: string;
  parameters: AppManifestToolSchema;
}

export interface AppManifestAuth {
  type: "none" | "api_key" | "oauth2";
  clientId?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  auth: AppManifestAuth;
  entry_url: string;
  iframe: AppManifestIframe;
  tools: AppManifestTool[];
  completion_events: string[];
}

// ── Penpal contract (PRD §4.2) ────────────────────────────────────────

export interface AppStateSummary {
  raw: Record<string, unknown>;
  display: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  displayText?: string;
}

export interface AppInitConfig {
  sessionId: string;
  theme: "light" | "dark";
  locale: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface OAuthAccessTokenResult {
  success: boolean;
  accessToken?: string;
  /** Unix seconds */
  expiresAt?: number;
  error?: string;
}

export interface PlatformMethods {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [key: string]: PlatformMethods | Function;
  notifyStateUpdate(state: AppStateSummary): Promise<void>;
  signalCompletion(event: string, summary: string): Promise<void>;
  requestResize(height: number): Promise<void>;
  requestAuth(provider: string, scopes: string[]): Promise<AuthResult>;
  getOAuthAccessToken(
    provider: string,
    appId: string,
  ): Promise<OAuthAccessTokenResult>;
}

export interface AppMethods {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [key: string]: AppMethods | Function;
  initialize(config: AppInitConfig): Promise<void>;
  invokeTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
  getState(): Promise<AppStateSummary>;
  destroy(): Promise<void>;
}

// ── Cloudflare Worker environment bindings ─────────────────────────────

export interface Env {
  DB: D1Database;
  APP_MANIFESTS: KVNamespace;
  CHAT_SESSION: DurableObjectNamespace;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  ANTHROPIC_API_KEY: string;
  JWT_SECRET: string;
  CF_AIG_TOKEN: string;
  /** Spotify OAuth (wrangler secret / .dev.vars) */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
}

// ── JWT payload ────────────────────────────────────────────────────────

export interface JWTPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

// ── SSE / WebSocket message types (PRD §6.2) ──────────────────────────

export type ClientMessage =
  | { type: "user_message"; content: string }
  | { type: "tool_result"; callId: string; result: ToolResult };

export type ServerMessage =
  | { type: "assistant_chunk"; content: string }
  | {
      type: "tool_invoke";
      callId: string;
      appId: string;
      tool: string;
      params: unknown;
    }
  | { type: "assistant_done"; messageId: string }
  | { type: "error"; message: string; retryable: boolean };
