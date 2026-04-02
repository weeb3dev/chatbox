# ChatBridge — Product Requirements Document

> **Version:** 1.0
> **Author:** Alberto Jauregui
> **Date:** March 31, 2026
> **Status:** Active
> **Stack:** Cloudflare (Workers, D1, Durable Objects, KV, AI Gateway, Pages) + Vite + React + Penpal

---

## 1. Overview

### 1.1 Product summary

ChatBridge is an AI chat platform that enables third-party mini-apps to run inside the conversation. Built as a fork of the open-source Chatbox desktop client, it adds a programmatic plugin interface that lets external applications register tools, render custom UI in sandboxed iframes, and communicate bidirectionally with the chatbot — with safety and security built into the contract from the start.

### 1.2 Target users

- **Students (K-12):** Interact with the chatbot and embedded apps during learning
- **Teachers:** Configure which apps are available, shape chatbot behavior
- **Third-party developers:** Build apps against the plugin contract
- **Graders (immediate audience):** Evaluate the architecture, plugin lifecycle, and integration quality

### 1.3 Success criteria

- Chat with streaming AI responses and persistent conversation history
- At least 3 third-party apps demonstrating different integration patterns
- Full plugin lifecycle: discovery → invocation → UI render → interaction → completion → follow-up
- User authentication for the platform
- At least one app with OAuth2 authentication
- Publicly deployed and accessible
- AI cost analysis with dev spend and production projections

---

## 2. Architecture

### 2.1 System diagram

```
BROWSER
├── Vite + React SPA (Jotai, TanStack Router)
│   └── Communicates with apps via Penpal (promise-based postMessage RPC)
└── Sandboxed iframes (one per active app, separate origin)

CLOUDFLARE EDGE
├── API Worker (REST routes, SSE/WebSocket streaming, auth middleware)
├── Chat Session Durable Object (per-conversation state, WebSocket, embedded SQLite)
├── D1 (messages, users, apps, OAuth tokens)
├── KV (app manifests, session cache)
└── AI Gateway (Claude proxy: caching, analytics, rate limiting, dynamic routing)

EXTERNAL
├── Claude Sonnet 4 (tool use + streaming, via AI Gateway)
├── App servers (Chess, App 2, App 3 — hosted on CF Pages, separate origins)
└── OAuth providers (for authenticated apps)
```

### 2.2 Key architectural decisions

| Decision | Choice | Rationale |
|---|---|---|
| App isolation | Sandboxed iframes | Only viable security boundary for K-12; prevents DOM access, data exfiltration |
| App ↔ Platform communication | Penpal | Promise-based RPC over postMessage; typed methods, automatic handshake, origin validation |
| Backend | Cloudflare Workers | Zero cold start, single-vendor deploy, V8 isolate security |
| Session state | Durable Objects with SQLite | Per-conversation coordination, WebSocket hibernation, zero-latency hot state |
| Persistent storage | D1 (SQLite) | Edge-local, free tier covers demo, migrations via Wrangler |
| LLM integration | Claude via AI Gateway | Transparent proxy adds caching, analytics, rate limiting, dynamic routing at zero code cost |
| Auth | Custom JWT via Web Crypto API | No external vendor dependency; email/password for platform, OAuth popup for per-app auth |
| Frontend | Vite + React (forked from Chatbox) | Escape from Chatbox's Electron/Webpack; CF Vite plugin provides Workers bindings in dev |
| Tool schema injection | Hybrid lazy loading | Always-available `list_available_apps` meta-tool; full schemas loaded only when app is active |

---

## 3. Features

### 3.1 Chat features

| Feature | Requirements | Priority |
|---|---|---|
| **Messaging** | Real-time AI chat with streaming responses via SSE (MVP) or WebSocket (Day 3-4) | P0 |
| **History** | Persistent conversation history across sessions, stored in D1 | P0 |
| **Context** | Chat maintains context about active third-party apps and their state | P0 |
| **Multi-turn** | Support complex multi-turn conversations that span app interactions | P0 |
| **Error recovery** | Graceful handling when apps fail, timeout, or return errors | P0 |
| **User auth** | Email/password → JWT, stored in D1 | P0 |

### 3.2 Third-party app integration

This is the core engineering challenge. The platform must provide a programmatic interface for third-party apps to:

| Capability | Implementation |
|---|---|
| Register themselves and their capabilities | App manifest (JSON) submitted to registration API, stored in KV |
| Define tool schemas the chatbot can discover and invoke | Manifest declares tools with JSON Schema parameters; converted to Claude tool definitions at runtime |
| Render their own UI within the chat experience | Sandboxed iframe loaded from app's `entry_url`; dimensions from manifest |
| Receive tool invocations from the chatbot | Platform calls `app.invokeTool(name, params)` via Penpal |
| Signal completion back to the chatbot | App calls `platform.signalCompletion(event, summary)` via Penpal |
| Maintain their own state independently | App owns its iframe state; provides `getState()` for platform to query summaries |

### 3.3 Authentication categories

The platform must handle three categories of apps:

| Type | Auth pattern | Example |
|---|---|---|
| Internal | No auth needed — bundled with platform | Calculator, unit converter |
| External (Public) | API key or none — no user-specific auth | Weather, dictionary lookup |
| External (Authenticated) | OAuth2 — user must authorize via popup window | Spotify, GitHub |

For OAuth2 apps: popup window flow (not iframe), tokens stored server-side in D1 (encrypted), automatic refresh, credentials passed to app via Penpal on initialization.

---

## 4. Plugin contract specification

### 4.1 App manifest schema

```jsonc
{
  "id": "chess-app",                    // Unique identifier
  "name": "Chess",                      // Display name
  "version": "1.0.0",
  "description": "Interactive chess game with AI analysis",
  "author": "ChatBridge",
  "category": "games",
  "auth": {
    "type": "none"                      // "none" | "api_key" | "oauth2"
  },
  "entry_url": "https://chess.chatbridge.pages.dev/embed",
  "iframe": {
    "width": "100%",
    "height": "400px",
    "sandbox": ["allow-scripts", "allow-forms"]
  },
  "tools": [
    {
      "name": "start_game",
      "description": "Start a new chess game",
      "parameters": {
        "type": "object",
        "properties": {
          "player_color": { "type": "string", "enum": ["white", "black"], "default": "white" },
          "difficulty": { "type": "string", "enum": ["beginner", "intermediate", "advanced"] }
        }
      }
    }
    // ... additional tools
  ],
  "completion_events": ["game_over", "user_resigned", "draw_agreed"]
}
```

### 4.2 Penpal communication interface

```typescript
// Platform exposes these methods TO the app (app calls them)
interface PlatformMethods {
  notifyStateUpdate(state: AppStateSummary): Promise<void>;
  signalCompletion(event: string, summary: string): Promise<void>;
  requestResize(height: number): Promise<void>;
  requestAuth(provider: string, scopes: string[]): Promise<AuthResult>;
}

// App exposes these methods TO the platform (platform calls them)
interface AppMethods {
  initialize(config: AppInitConfig): Promise<void>;
  invokeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  getState(): Promise<AppStateSummary>;
  destroy(): Promise<void>;
}

interface AppStateSummary {
  raw: Record<string, unknown>;   // For storage/restore
  display: string;                // Human-readable for LLM context
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  displayText?: string;           // Human-readable for LLM — REQUIRED for quality
}

interface AppInitConfig {
  sessionId: string;
  theme: "light" | "dark";
  locale: string;
}

interface AuthResult {
  success: boolean;
  error?: string;
}
```

### 4.3 Tool invocation lifecycle

```
1. User sends message
2. Worker builds Claude request:
   - System prompt with platform instructions
   - Active app context summaries
   - Tool array: list_available_apps (always) + active app tools (if session active)
3. Request routed through AI Gateway → Claude
4. Claude returns tool_use block(s)
5. Worker sends tool invocation to client via SSE/WebSocket
6. Client calls iframe via Penpal: app.invokeTool(name, params)
7. App executes, returns ToolResult with displayText
8. Client sends tool_result back to Worker
9. Worker sends tool_result to Claude (via AI Gateway)
10. Claude generates response incorporating tool result
11. Response streamed to client
```

### 4.4 Completion signaling

When an app finishes its interaction (game over, data loaded, playlist created):

1. App calls `platform.signalCompletion(event, summary)`
2. Platform validates origin, stores summary in `app_sessions` table
3. Summary injected into next Claude call as context
4. Claude naturally continues conversation referencing the completed interaction
5. Platform optionally minimizes/hides the iframe

**Edge cases to handle:**
- App never signals completion → timeout (configurable, default 10 min) + user close button + implicit detection (3+ messages with no app interaction)
- App crashes mid-session → Penpal connection drop → error state UI, offer restart
- User refreshes page → iframe state lost → `state_summary` from D1 used for recovery or "session was lost" notification

### 4.5 Iframe sandbox configuration

```html
<iframe
  src="{app.entry_url}"
  sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerpolicy="no-referrer"
  loading="lazy"
/>
```

- `allow-same-origin` is **never** included — prevents app from accessing platform cookies/storage
- `allow-popups` + `allow-popups-to-escape-sandbox` required for OAuth popup flow
- `allow-top-navigation` is **never** included — prevents app from redirecting page

---

## 5. Data model

### 5.1 D1 schema

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | suspended
  entry_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none',  -- none | api_key | oauth2
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,              -- user | assistant | tool_call | tool_result | system
  content TEXT,
  tool_name TEXT,
  tool_params TEXT,                -- JSON string
  tool_result TEXT,                -- JSON string
  app_id TEXT REFERENCES apps(id),
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  app_id TEXT NOT NULL REFERENCES apps(id),
  status TEXT NOT NULL DEFAULT 'active',  -- active | completed | error | timeout
  state_summary TEXT,              -- Human-readable for LLM context
  state_raw TEXT,                  -- JSON for app state restore
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE app_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  app_id TEXT NOT NULL REFERENCES apps(id),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_messages_conversation ON messages(conversation_id, sequence_num);
CREATE INDEX idx_app_sessions_conversation ON app_sessions(conversation_id, status);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at);
CREATE INDEX idx_app_tokens_user_app ON app_tokens(user_id, app_id);
```

### 5.2 KV namespace

| Key pattern | Value | Purpose |
|---|---|---|
| `app:{appId}` | App manifest JSON | Fast read for tool schema injection; written on registration |
| `app:list` | Array of approved app summaries | `list_available_apps` tool response |

### 5.3 Durable Object SQLite (per Chat Session)

Hot state co-located with the DO instance:

| Table | Purpose |
|---|---|
| `session_messages` | Current conversation messages (cache, avoids D1 roundtrip per turn) |
| `active_apps` | Currently active app sessions with state summaries |
| `pending_tool_calls` | In-flight tool invocations awaiting iframe response |

On session end or DO eviction, summaries flush to D1.

---

## 6. API endpoints

### 6.1 Platform API (Worker)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create user account |
| `POST` | `/api/auth/login` | Authenticate, return JWT |
| `GET` | `/api/conversations` | List user's conversations |
| `POST` | `/api/conversations` | Create new conversation |
| `GET` | `/api/conversations/:id` | Get conversation with messages |
| `DELETE` | `/api/conversations/:id` | Delete conversation |
| `POST` | `/api/chat` | Send message, returns SSE stream of AI response |
| `POST` | `/api/chat/tool-result` | Submit tool result from client after iframe execution |
| `GET` | `/api/apps` | List available (approved) apps |
| `POST` | `/api/apps/register` | Register a new app (submit manifest) |
| `GET` | `/api/apps/:id/manifest` | Get app manifest |
| `GET` | `/api/oauth/:appId/authorize` | Initiate OAuth flow for an app (returns redirect URL) |
| `GET` | `/api/oauth/:appId/callback` | OAuth callback endpoint (stores tokens, closes popup) |

### 6.2 WebSocket endpoint (Durable Object)

| Path | Purpose |
|---|---|
| `/ws/chat/:conversationId` | WebSocket connection for real-time chat (upgrade from Day 3-4) |

WebSocket message types:

```typescript
// Client → Server
type ClientMessage =
  | { type: "user_message"; content: string }
  | { type: "tool_result"; callId: string; result: ToolResult }

// Server → Client
type ServerMessage =
  | { type: "assistant_chunk"; content: string }          // Streaming text
  | { type: "tool_invoke"; callId: string; appId: string; tool: string; params: unknown }
  | { type: "assistant_done"; messageId: string }
  | { type: "error"; message: string; retryable: boolean }
```

---

## 7. Third-party apps

### 7.1 Required: Chess

| Aspect | Specification |
|---|---|
| Libraries | `chess.js` (game logic, validation, FEN) + `react-chessboard` (UI) |
| Auth | None |
| Hosting | Cloudflare Pages (separate project, own `*.pages.dev` origin) |
| Tools | `start_game`, `make_move`, `get_board_state`, `analyze_position` |
| Completion events | `game_over`, `user_resigned`, `draw_agreed` |
| LLM context | FEN string (raw) + human-readable position summary (displayText) |
| Key test | Full lifecycle: "let's play chess" → board appears → mid-game "what should I do?" → chatbot analyzes via `get_board_state` → game ends → chatbot discusses result |

### 7.2 App 2 — TBD (no auth or API key)

Candidates: Weather dashboard (Open-Meteo), Nature ID / Field guide (Claude Vision or iNaturalist), Flashcard / Quiz maker

Decision criteria: simple integration pattern, demonstrates fire-and-forget or lightweight state

### 7.3 App 3 — TBD (OAuth2)

Candidates: Spotify Playlist Creator, GitHub Issues

Decision criteria: demonstrates full auth popup flow, token storage, API proxy pattern

### 7.4 Auth pattern coverage

| App | Auth pattern | Complexity |
|---|---|---|
| Chess | None | High (ongoing state, bidirectional) |
| App 2 | None or API key | Low-Medium |
| App 3 | OAuth2 | Medium (auth flow is the challenge) |

---

## 8. Testing scenarios

The platform will be tested against these 7 scenarios (per spec):

| # | Scenario | Success criteria |
|---|---|---|
| 1 | Tool discovery and invocation | User says "play chess" → chatbot calls `start_game` → board loads |
| 2 | App UI renders in chat | Chess board appears inline within the message stream |
| 3 | User interacts with app, returns to chat | User plays moves via board UI, says "I'm done" → iframe minimizes, chat resumes |
| 4 | Context retention after completion | User asks "how did that game go?" → chatbot recalls game result from stored summary |
| 5 | Multiple apps in one conversation | User plays chess, then checks weather, then asks about the chess game → all context retained |
| 6 | Ambiguous query routing | User says "show me something fun" → chatbot clarifies or uses `list_available_apps` |
| 7 | Correct refusal for unrelated queries | User asks "what's 2+2?" → chatbot answers directly, no app invoked |

---

## 9. Security requirements

| Requirement | Implementation |
|---|---|
| Iframe isolation | `sandbox` without `allow-same-origin`; each app on its own `*.pages.dev` origin |
| Data access default | Apps receive zero conversation history or student PII unless explicitly scoped |
| Content scanning | Platform filters content from app→chat messages before LLM injection (prevent prompt injection via `displayText`) |
| CSP headers | `frame-src` restricted to allowlisted app origins |
| Rate limiting | Per-app token bucket (60 calls/min) via Workers rate limiting; per-gateway LLM rate limiting via AI Gateway |
| Secret management | API keys stored as Worker secrets (`wrangler secret put`), never in code or KV |
| OAuth tokens | Encrypted at rest in D1, refreshed server-side, never exposed to client iframe |
| App approval | Status workflow: `pending` → `approved` / `rejected` / `suspended` |
| Circuit breaker | 3 failures in 5 min → app marked `degraded`; 10 failures → auto-disabled for session |

---

## 10. Error handling

| Failure mode | Detection | Recovery |
|---|---|---|
| Iframe fails to load | `onerror` event / load timeout (5s) | Error card in chat, retry button |
| Tool call times out | Penpal timeout (10s) | Error returned to Claude, chatbot explains to user |
| App crashes mid-session | Penpal connection drop | Store last known state, offer restart or dismiss |
| LLM API error | HTTP error / stream interruption | Retry with exponential backoff (max 3 attempts) |
| OAuth popup blocked | `window.open()` returns null | Instruct user to allow popups for this site |
| D1 write failure | Supabase error response | Queue in memory, retry |
| DO eviction (idle 30s) | Automatic by runtime | All state in `ctx.storage` persists; reconstruct in-memory state on wake |

---

## 11. LLM integration

### 11.1 Model

Claude Sonnet 4 (`claude-sonnet-4-20250514`) via Cloudflare AI Gateway.

### 11.2 System prompt structure

```
Platform behavior instructions (~300 tokens)
├── "You are a helpful AI assistant in a K-12 education platform..."
├── "You can invoke third-party apps when the user requests them..."
├── "Always include context from active app sessions..."
└── "When an app signals completion, acknowledge the result naturally..."

Active app context (~200 tokens per active app)
├── "Chess game is active. Current state: {state_summary}"
└── "Last interaction: {last_tool_result.displayText}"

Available apps summary (~100 tokens, always present)
└── "Available apps: Chess (interactive chess game), Weather (weather lookup), ..."
```

### 11.3 Tool array (dynamic, per-request)

```
Always present:
├── list_available_apps: Returns details of all registered apps

Loaded when app is active:
├── [chess tools]: start_game, make_move, get_board_state, analyze_position
├── [app2 tools]: ...
└── [app3 tools]: ...
```

### 11.4 AI Gateway configuration

| Feature | Configuration | Phase |
|---|---|---|
| Response caching | Enabled, 1-month TTL | Day 1 |
| Analytics | Enabled, `cf-aig-metadata` tags per request (userId, appId) | Day 1 |
| Rate limiting | 100 requests/min per gateway | Day 1 |
| Logging | Enabled, free tier (100K/month) | Day 1 |
| Dynamic routing | Haiku for simple routing, Sonnet for complex reasoning | Day 5-7 |
| Guardrails | Content filtering for K-12 safety (beta evaluation) | Day 5-7 |

---

## 12. Deployment

| Component | Service | Deploy |
|---|---|---|
| Frontend + Backend | Workers (static assets + API) | `wrangler deploy` |
| Database | D1 | `wrangler d1 migrations apply` |
| LLM proxy | AI Gateway | Dashboard config |
| Session state | Durable Objects | Deployed with Worker |
| Manifest cache | KV | Deployed with Worker |
| Chess app | Pages (separate project) | `wrangler pages deploy` |
| App 2 | Pages (separate project) | `wrangler pages deploy` |
| App 3 | Pages (separate project) | `wrangler pages deploy` |

All services on Cloudflare. Single `wrangler deploy` for the platform. Separate Pages deploys per app for origin isolation.

---

## 13. Milestones

### MVP — Tuesday (24h)

- [ ] Fork Chatbox, scaffold Vite + React + TypeScript
- [ ] Evaluate Agents SDK vs raw fetch (1hr decision gate)
- [ ] Set up wrangler.jsonc: D1, KV, DO, AI Gateway
- [ ] Basic chat: user → AI Gateway → Claude → streamed response
- [ ] Conversation CRUD (create, list, load, delete)
- [ ] User auth: email/password → JWT
- [ ] Prototype: single iframe with Penpal handshake in chat
- [ ] Pre-search document
- [ ] Architecture video (3-5 min)

### Early submission — Friday (96h)

- [ ] App manifest registration API + KV storage
- [ ] Tool schema → Claude tool definition converter
- [ ] Full tool invocation lifecycle (all 11 steps from §4.3)
- [ ] Completion signaling + context injection
- [ ] Chess app: full lifecycle working
- [ ] App 2: built and integrated
- [ ] App 3: built with OAuth flow
- [ ] Error handling: timeouts, crashes, circuit breaker
- [ ] DO WebSocket upgrade (from SSE)

### Final submission — Sunday (168h)

- [ ] Multi-app routing refinement (ambiguous queries)
- [ ] AI Gateway dynamic routing (Haiku/Sonnet split)
- [ ] UI polish: loading states, app containers, transitions
- [ ] Developer documentation / API reference
- [ ] AI cost analysis (from AI Gateway dashboard)
- [ ] Deploy all services
- [ ] Demo video (3-5 min)
- [ ] Social post (X or LinkedIn, tag @GauntletAI)

---

## 14. Open risks

| Risk | Severity | Mitigation |
|---|---|---|
| Penpal + sandbox without `allow-same-origin` | Medium | Spike test in first 2 hours of Day 1; fall back to raw postMessage wrapper if broken |
| Agents SDK doesn't support dynamic tool registration | Low | Raw `fetch()` through AI Gateway is proven fallback; 1hr max evaluation |
| D1 latency on long conversation history loads | Medium | Cache current conversation in DO SQLite; only hit D1 on initial load |
| Worker CPU limit (10ms free tier) | Low | Claude calls are I/O-bound (exempt); upgrade to paid ($5/mo) if JSON parsing hits limit |
| App 3 OAuth complexity exceeds time budget | Low | GitHub Issues (simpler API) is fallback for Spotify |
| Chatbox fork has deeper Electron entanglement than expected | Medium | Break-glass: clean Vite scaffold borrowing Chatbox UI components only |