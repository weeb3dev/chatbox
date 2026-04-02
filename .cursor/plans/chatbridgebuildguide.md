# ChatBridge — Step-by-Step Build Guide

> **Who this is for:** A developer building ChatBridge from scratch using Cursor with Claude Opus 4.6.
> **Time:** 7 days (MVP by Day 1, Early by Day 4, Final by Day 7)
> **Prerequisites:** Node.js v20+, npm, a Cloudflare account, an Anthropic API key, Git, Cursor IDE with Cloudflare plugin installed

---

## How to use this guide

Each phase has numbered steps. Each step has:
- **What you're doing** (the goal)
- **Commands to run** (copy-paste into terminal)
- **Cursor prompts** (copy-paste into Cursor chat with Claude Opus 4.6)
- **What to verify** (how to know it worked)

> **Cursor tip:** When pasting a prompt, add `@chatbridge-prd.md` and `@chatbridge-presearch-cloudflare.md` as context files in Cursor so Claude has the full spec. Keep both files in your project root.

---

## Phase 0: Project setup (30 min)

### Step 0.1 — Fork and clone Chatbox

The project is built on a fork of the open-source Chatbox app. We'll fork it to preserve Git lineage, then build our own project alongside it.

```bash
# Fork https://github.com/chatboxai/chatbox on GitHub/GitLab first, then:
git clone https://github.com/YOUR_USERNAME/chatbox.git chatbridge
cd chatbridge
git remote add upstream https://github.com/chatboxai/chatbox.git
```

**Verify:** `ls src/renderer/` shows the React components we'll reference later.

### Step 0.2 — Scaffold the Vite + React project

We're not using Chatbox's Electron build. We scaffold a fresh Vite project in the same repo.

```bash
# From the chatbridge root directory
npm create vite@latest app -- --template react-ts
cd app
npm install
```

**Verify:** `cd app && npm run dev` opens a Vite welcome page at `http://localhost:5173`.

### Step 0.3 — Install the Cloudflare Vite plugin

This lets us run Workers code in dev and deploy to Cloudflare with one command.

```bash
# From the app/ directory
npm install @cloudflare/vite-plugin wrangler --save-dev
```

Now create the Wrangler configuration file:

```bash
touch wrangler.jsonc
```

**Cursor prompt:**
```
Create a wrangler.jsonc file for a Cloudflare Workers project called "chatbridge" with:
- A D1 database binding called "DB" (database_name: "chatbridge-db")
- A KV namespace binding called "APP_MANIFESTS"
- A Durable Object binding called "CHAT_SESSION" pointing to class "ChatSession"
- Compatibility date of today
- nodejs_compat flag enabled
- Static assets configured for Vite SPA with not_found_handling: "single-page-application"

Use placeholder IDs for now — I'll fill them in after creating the resources.
```

**Verify:** `wrangler.jsonc` exists with D1, KV, and DO bindings.

### Step 0.4 — Create Cloudflare resources

```bash
# Create the D1 database
npx wrangler d1 create chatbridge-db

# Create the KV namespace
npx wrangler kv namespace create APP_MANIFESTS
```

Both commands will print IDs. Copy them into your `wrangler.jsonc` file, replacing the placeholders.

```bash
# Store your Anthropic API key as a secret (never in code)
npx wrangler secret put ANTHROPIC_API_KEY
# Paste your key when prompted
```

**Verify:** `npx wrangler d1 list` shows `chatbridge-db`. `npx wrangler kv namespace list` shows `APP_MANIFESTS`.

### Step 0.5 — Create the AI Gateway

This is done in the Cloudflare dashboard, not the CLI:

1. Go to https://dash.cloudflare.com → AI → AI Gateway
2. Click "Create Gateway"
3. Name it `chatbridge-gateway`
4. Note your Account ID and Gateway ID
5. Enable authentication on the gateway

```bash
# Store the gateway token as a secret
npx wrangler secret put CF_AIG_TOKEN
# Paste the token when prompted

# Also store these as regular env vars in wrangler.jsonc under [vars]:
# CF_ACCOUNT_ID = "your-account-id"
# AI_GATEWAY_ID = "chatbridge-gateway"
```

**Verify:** The AI Gateway dashboard shows your gateway as active with 0 requests.

### Step 0.6 — Set up the Vite config with Cloudflare plugin

**Cursor prompt:**
```
Update vite.config.ts to use the @cloudflare/vite-plugin. Configure it to:
- Use the wrangler.jsonc in the project root
- Serve the React SPA with the Workers runtime in dev
- Support hot module replacement

Reference the Cloudflare Vite plugin docs for the correct setup.
```

**Verify:** `npm run dev` starts with Cloudflare Workers runtime messages in the terminal.

### Step 0.7 — Set up project structure

```bash
# From the app/ directory
mkdir -p src/{components,hooks,lib,pages,stores,types,workers}
mkdir -p src/components/{chat,apps,auth,ui}
```

**Target structure:**
```
app/
├── src/
│   ├── components/
│   │   ├── chat/         # Chat UI components
│   │   ├── apps/         # App iframe container, app cards
│   │   ├── auth/         # Login/register forms
│   │   └── ui/           # Shared UI (buttons, inputs, loading)
│   ├── hooks/            # React hooks (useChat, useApps, useAuth)
│   ├── lib/              # Utilities (api client, penpal helpers)
│   ├── pages/            # Route pages
│   ├── stores/           # Jotai atoms
│   ├── types/            # TypeScript interfaces
│   └── workers/          # Cloudflare Worker entry + DO class
├── migrations/           # D1 SQL migrations
├── wrangler.jsonc
├── vite.config.ts
└── package.json
```

---

## Phase 1: Database and auth (2-3 hours)

### Step 1.1 — Create the D1 migration

```bash
mkdir -p migrations
touch migrations/0001_initial.sql
```

**Cursor prompt:**
```
Create the SQL migration file at migrations/0001_initial.sql using the exact schema from the PRD section 5.1. Include all 6 tables (users, apps, conversations, messages, app_sessions, app_tokens) and all 4 indexes. Use SQLite syntax — TEXT for all IDs, datetime('now') for defaults.
```

Apply the migration locally:

```bash
npx wrangler d1 migrations apply chatbridge-db --local
```

**Verify:** `npx wrangler d1 execute chatbridge-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"` shows all 6 tables.

### Step 1.2 — Create TypeScript types

**Cursor prompt:**
```
Create src/types/index.ts with TypeScript interfaces for the ChatBridge data model:

1. User (id, email, displayName, createdAt)
2. App (id, name, slug, manifest, status, entryUrl, authType, createdAt)
3. Conversation (id, userId, title, createdAt, updatedAt)
4. Message (id, conversationId, role: 'user'|'assistant'|'tool_call'|'tool_result'|'system', content, toolName, toolParams, toolResult, appId, sequenceNum, createdAt)
5. AppSession (id, conversationId, appId, status: 'active'|'completed'|'error'|'timeout', stateSummary, stateRaw, startedAt, completedAt)
6. AppManifest (the manifest schema from PRD section 4.1 — id, name, version, description, author, category, auth, entry_url, iframe, tools array, completion_events)
7. ToolResult (success, data, error, displayText)
8. AppStateSummary (raw, display)
9. PlatformMethods and AppMethods interfaces (from PRD section 4.2)

Export everything. Use strict types — no `any`.
```

**Verify:** No TypeScript errors in the file.

### Step 1.3 — Build the Worker entry point

This is the main API server. It handles all HTTP requests.

**Cursor prompt:**
```
Create src/workers/index.ts as a Cloudflare Worker entry point.

It should:
1. Import the Hono framework for routing (install it: npm install hono)
2. Define typed environment bindings for DB (D1), APP_MANIFESTS (KV), CHAT_SESSION (DurableObjectNamespace), and vars (CF_ACCOUNT_ID, AI_GATEWAY_ID)
3. Set up a Hono app with these route groups:
   - /api/auth/* (register, login)
   - /api/conversations/* (CRUD)
   - /api/chat (POST — main chat endpoint)
   - /api/chat/tool-result (POST — tool result submission)
   - /api/apps/* (list, register, get manifest)
4. Export the ChatSession Durable Object class (empty for now)
5. Export default the Hono app as the Worker fetch handler

For now, stub every route to return { status: "ok" } — we'll implement them one by one.

Use Hono's built-in middleware for CORS and JSON parsing.
```

Install Hono:
```bash
npm install hono
```

**Verify:** `npm run dev` starts without errors. `curl http://localhost:5173/api/auth/login` returns `{"status":"ok"}`.

### Step 1.4 — Implement auth routes

**Cursor prompt:**
```
Implement the auth routes in the Worker:

POST /api/auth/register:
- Accepts { email, password, displayName }
- Validates email format and password length (min 8)
- Hashes password using Web Crypto API (PBKDF2 with random salt, store salt:hash)
- Generates a UUID for the user ID
- Inserts into D1 users table
- Returns a signed JWT (HS256 via Web Crypto API) containing { userId, email }
- JWT expires in 7 days

POST /api/auth/login:
- Accepts { email, password }
- Looks up user by email in D1
- Verifies password against stored hash using PBKDF2
- Returns a signed JWT

Create an auth middleware that:
- Reads the Authorization: Bearer <token> header
- Verifies the JWT signature using Web Crypto API
- Attaches userId and email to the Hono context
- Returns 401 if invalid or missing

Apply the middleware to all routes EXCEPT /api/auth/*.

The JWT_SECRET should come from env (store it with: npx wrangler secret put JWT_SECRET)
```

Set the JWT secret:
```bash
npx wrangler secret put JWT_SECRET
# Type a random string, e.g.: chatbridge-dev-secret-change-in-prod
```

**Verify:** Use curl to register and login:
```bash
# Register
curl -X POST http://localhost:5173/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123","displayName":"Test User"}'

# Login (should return a JWT)
curl -X POST http://localhost:5173/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}'
```

### Step 1.5 — Implement conversation CRUD

**Cursor prompt:**
```
Implement the conversation routes (all require auth middleware):

GET /api/conversations
- Query D1 for all conversations where user_id = authenticated user
- Order by updated_at DESC
- Return array of { id, title, createdAt, updatedAt }

POST /api/conversations
- Accepts optional { title }
- Auto-generates title as "New conversation" if not provided
- Inserts into D1, returns the new conversation object

GET /api/conversations/:id
- Verify the conversation belongs to the authenticated user
- Return the conversation with all its messages ordered by sequence_num
- Include any active app_sessions

DELETE /api/conversations/:id
- Verify ownership
- Delete all messages, app_sessions, then the conversation
- Return { success: true }

Use parameterized queries for all D1 operations to prevent SQL injection.
Generate UUIDs with crypto.randomUUID().
```

**Verify:** Create a conversation via curl, then fetch it back:
```bash
TOKEN="your-jwt-from-login"
curl -X POST http://localhost:5173/api/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test conversation"}'
```

---

## Phase 2: Chat with Claude (2-3 hours)

This is where the AI comes alive.

### Step 2.1 — Build the Claude client

**Cursor prompt:**
```
Create src/workers/claude.ts that handles communication with Claude via AI Gateway.

It should export an async function callClaude(params) that:
1. Builds the AI Gateway URL: https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AI_GATEWAY_ID}/anthropic/v1/messages
2. Sends a POST request with:
   - x-api-key header (ANTHROPIC_API_KEY from env)
   - cf-aig-authorization header (CF_AIG_TOKEN from env)
   - cf-aig-metadata header with JSON: { userId, appId, hasToolSchemas }
   - anthropic-version: 2023-06-01
   - Body: { model: "claude-sonnet-4-20250514", max_tokens: 4096, system, tools, messages, stream: true }
3. Returns the raw Response object (we'll stream it through to the client)

Also export a buildSystemPrompt(activeApps, appSessions) function that constructs the system prompt:
- Platform behavior instructions
- Active app context summaries (from appSessions)
- Available apps list (names + one-line descriptions)

Also export a buildToolArray(activeAppManifests) function that:
- Always includes a "list_available_apps" tool
- Adds tools from active app manifests
- Converts manifest tool schemas to Claude's tool format
```

**Verify:** The file compiles without TypeScript errors.

### Step 2.2 — Implement the chat endpoint with streaming

**Cursor prompt:**
```
Implement POST /api/chat in the Worker.

Request body: { conversationId, content }

The endpoint should:
1. Verify the conversation belongs to the authenticated user
2. Save the user message to D1 (role: 'user', increment sequence_num)
3. Load conversation history from D1 (all messages for this conversation)
4. Load active app sessions for this conversation
5. Load manifests for active apps from KV
6. Build the system prompt and tool array using the functions from claude.ts
7. Call Claude via AI Gateway with stream: true
8. Return an SSE response that streams Claude's response to the client

For the SSE stream:
- Set headers: Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive
- Use a TransformStream to process Claude's SSE chunks
- For each text_delta event, forward it as: data: {"type":"chunk","content":"..."}\n\n
- When a tool_use block is detected, send: data: {"type":"tool_invoke","callId":"...","appId":"...","tool":"...","params":{...}}\n\n
- When streaming is complete, save the assistant message to D1 and send: data: {"type":"done","messageId":"..."}\n\n
- On error, send: data: {"type":"error","message":"..."}\n\n

Use ReadableStream and TextDecoder to parse Claude's SSE format.
```

This is the most complex endpoint. Take your time verifying it.

**Verify:** Test with curl (won't have tools yet, just basic chat):
```bash
# First create a conversation and note the ID
curl -X POST http://localhost:5173/api/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"YOUR_CONV_ID","content":"Hello, what can you do?"}'
```

You should see SSE events streaming back.

### Step 2.3 — Implement the tool result endpoint

**Cursor prompt:**
```
Implement POST /api/chat/tool-result in the Worker.

Request body: { conversationId, callId, result: ToolResult }

This endpoint is called by the frontend after the iframe executes a tool invocation.

It should:
1. Save the tool_result message to D1 (role: 'tool_result')
2. Load the full conversation history (now including the tool result)
3. Call Claude again with the updated history (Claude needs to see the tool_result to generate its next response)
4. Return an SSE stream of Claude's follow-up response (same streaming logic as /api/chat)

This creates the round-trip: user message → Claude → tool_use → app executes → tool_result → Claude → final response.
```

**Verify:** This endpoint will be fully testable once we have the frontend and an app connected.

---

## Phase 3: Frontend — chat UI (3-4 hours)

### Step 3.1 — Install frontend dependencies

```bash
npm install jotai @tanstack/react-router penpal
npm install -D tailwindcss @tailwindcss/vite
```

**Cursor prompt:**
```
Set up Tailwind CSS v4 with the Vite plugin. Update vite.config.ts to include the Tailwind plugin. Create a src/index.css that imports Tailwind's base styles. Keep it minimal — we'll add custom styles later.
```

### Step 3.2 — Set up Jotai stores

**Cursor prompt:**
```
Create Jotai atoms in src/stores/:

src/stores/auth.ts:
- authTokenAtom: string | null (persisted to localStorage)
- userAtom: derived atom that decodes the JWT to get userId and email
- isAuthenticatedAtom: derived boolean

src/stores/conversations.ts:
- conversationsAtom: Conversation[] (loaded from API)
- activeConversationIdAtom: string | null
- activeConversationAtom: derived atom that finds the active conversation
- messagesAtom: Message[] for the active conversation

src/stores/apps.ts:
- availableAppsAtom: App[] (loaded from API)
- activeAppSessionsAtom: AppSession[] for the current conversation

All atoms that load from the API should use Jotai's atomWithDefault or atomEffect pattern to trigger fetches.
Create a src/lib/api.ts helper that wraps fetch with the JWT token from authTokenAtom and the base URL.
```

### Step 3.3 — Build the auth pages

**Cursor prompt:**
```
Create the login and register pages:

src/pages/LoginPage.tsx:
- Email and password inputs
- Submit button that calls POST /api/auth/login
- On success: store JWT in authTokenAtom, redirect to /chat
- Link to register page
- Clean, minimal design with Tailwind. Center on screen.

src/pages/RegisterPage.tsx:
- Email, password, display name inputs
- Submit button that calls POST /api/auth/register
- On success: store JWT, redirect to /chat
- Link to login page

Both should show error messages on failure (invalid credentials, email taken, etc.)
```

### Step 3.4 — Build the chat layout

This is the main interface. Reference Chatbox's `src/renderer/` components for layout inspiration.

**Cursor prompt:**
```
Create the main chat layout with three sections:

src/pages/ChatPage.tsx — the main page (requires auth):
- Left sidebar (250px): conversation list, "New chat" button, user info at bottom
- Center panel (flex-1): message list + input area
- Right panel (conditional, 350px): shows when an app iframe is active

src/components/chat/ConversationList.tsx:
- Lists conversations from conversationsAtom
- Click to select (sets activeConversationIdAtom)
- Active conversation is highlighted
- "New chat" button at top creates a conversation via API

src/components/chat/MessageList.tsx:
- Renders messages from messagesAtom
- User messages right-aligned, assistant messages left-aligned
- Tool call messages show a subtle "Using [app name]..." indicator
- Tool result messages are hidden (the assistant response that follows is what the user sees)
- Auto-scrolls to bottom on new messages
- Shows a typing indicator when waiting for AI response

src/components/chat/ChatInput.tsx:
- Text input with send button
- Submit on Enter (Shift+Enter for newline)
- Disabled while waiting for AI response
- Calls POST /api/chat with the message content

Style everything with Tailwind. Dark theme preferred (matches the slide deck aesthetic).
Use a clean, modern chat UI — rounded message bubbles, subtle shadows, comfortable spacing.
```

### Step 3.5 — Implement SSE streaming on the frontend

This connects the chat input to the streaming backend.

**Cursor prompt:**
```
Create src/hooks/useChat.ts — a custom hook that manages the chat flow:

1. sendMessage(content: string) function:
   a. Add the user message to messagesAtom optimistically
   b. POST to /api/chat with { conversationId, content }
   c. Read the SSE stream using EventSource or fetch + ReadableStream
   d. For each "chunk" event: append text to a streaming assistant message in messagesAtom
   e. For each "tool_invoke" event: store the invocation in a pendingToolCallAtom (the app iframe handler will pick this up)
   f. For each "done" event: finalize the assistant message with the real messageId
   g. For "error" events: show an error state

2. submitToolResult(callId: string, result: ToolResult) function:
   a. POST to /api/chat/tool-result with { conversationId, callId, result }
   b. Read the follow-up SSE stream (same handling as step 1c-g)

Important: use fetch() with ReadableStream for SSE, not the EventSource API.
EventSource doesn't support POST requests or custom headers (we need the JWT).

Parse the SSE format manually:
- Split on "\n\n" to get events
- Each event starts with "data: " followed by JSON
- Parse the JSON and dispatch based on the "type" field
```

**Verify:** You should now be able to chat with Claude through the UI. Messages stream in character by character. No tool use yet — that comes next.

### Step 3.6 — Set up routing

**Cursor prompt:**
```
Set up TanStack Router with these routes:

/ → redirect to /chat if authenticated, /login if not
/login → LoginPage
/register → RegisterPage
/chat → ChatPage (protected — redirect to /login if not authenticated)

Create src/routes.ts with the route definitions.
Update src/main.tsx to wrap the app in the router provider.
```

**Verify:** Opening `http://localhost:5173` redirects to login. After logging in, you see the chat interface and can send messages.

---

## Phase 4: Plugin system — the core challenge (4-6 hours)

### Step 4.1 — Implement app registration API

**Cursor prompt:**
```
Implement the app registration endpoints in the Worker:

POST /api/apps/register:
- Accepts a full app manifest (JSON body matching the AppManifest type)
- Validates the manifest: required fields (id, name, entry_url, tools), tool schema structure
- Stores the manifest in KV under key "app:{appId}"
- Inserts a record into the D1 apps table with status 'approved' (auto-approve for the sprint)
- Updates the "app:list" KV key with the updated list of approved apps
- Returns the created app record

GET /api/apps:
- Returns all approved apps from the "app:list" KV key
- Includes basic info: id, name, description, category, authType

GET /api/apps/:id/manifest:
- Returns the full manifest from KV
```

### Step 4.2 — Build the list_available_apps tool

This is the "router" tool that Claude always has access to.

**Cursor prompt:**
```
Update the buildToolArray function in claude.ts:

The list_available_apps tool should always be included:
{
  name: "list_available_apps",
  description: "List all available third-party apps that can be used in this conversation. Call this when the user asks to use an app or when you need to discover what apps are available.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional search query to filter apps by name or description"
      }
    }
  }
}

When Claude calls this tool, the Worker should:
1. Read the "app:list" KV key
2. Return the list of apps with their names, descriptions, and available tools
3. Inject the selected app's full tool schemas into the NEXT Claude call

This is the "lazy loading" pattern — tools are only loaded when needed.
```

### Step 4.3 — Build the iframe container component

This is where apps render inside the chat.

**Cursor prompt:**
```
Create src/components/apps/AppContainer.tsx:

This component:
1. Receives an app manifest and renders a sandboxed iframe
2. Uses Penpal to establish a connection with the iframe
3. Exposes PlatformMethods to the app (from the PRD section 4.2):
   - notifyStateUpdate(state) → stores the state summary in activeAppSessionsAtom
   - signalCompletion(event, summary) → marks the app session as completed, stores summary
   - requestResize(height) → adjusts the iframe height
   - requestAuth(provider, scopes) → opens OAuth popup (implement later)
4. Receives AppMethods from the app:
   - initialize, invokeTool, getState, destroy

Iframe attributes (from PRD section 4.5):
  sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerpolicy="no-referrer"

The component should:
- Show a loading spinner while the Penpal connection is being established
- Show an error state if the connection fails or times out (5s)
- Have a close/minimize button that calls app.destroy() and hides the iframe

Install Penpal: already installed in step 3.1.

Important: import Penpal's connectToChild function. Example:
import { connectToChild } from 'penpal';

const connection = connectToChild({
  iframe: iframeRef.current,
  methods: platformMethods,
  timeout: 5000,
});
const appMethods = await connection.promise;
```

### Step 4.4 — Wire tool invocations to the iframe

This connects Claude's tool_use responses to the actual app execution.

**Cursor prompt:**
```
Create src/hooks/useAppBridge.ts — a hook that bridges tool invocations between the chat and app iframes:

It should:
1. Watch for pendingToolCallAtom changes (set by the SSE stream handler)
2. When a tool invocation arrives:
   a. Look up the app's manifest from availableAppsAtom
   b. If no iframe is open for this app, open one (set activeAppSessionAtom, render AppContainer)
   c. Call appMethods.invokeTool(toolName, params) via the Penpal connection
   d. Receive the ToolResult
   e. Call submitToolResult(callId, result) from useChat to send it back to Claude
3. Handle errors: if invokeTool throws or times out, return an error ToolResult to Claude
4. Handle the "list_available_apps" tool locally — no iframe needed, just return the app list

This is the 4-hop async chain described in the presearch:
SSE event → client detects tool_invoke → Penpal call to iframe → iframe responds → client sends tool_result → Claude responds
```

### Step 4.5 — Create the app session lifecycle

**Cursor prompt:**
```
Create src/hooks/useAppSession.ts — manages the lifecycle of app sessions within a conversation:

startAppSession(appId, conversationId):
- Create an app_session record via API (POST to a new endpoint: /api/app-sessions)
- Set the activeAppSessionsAtom
- Load the manifest and render the AppContainer

endAppSession(sessionId):
- Mark the session as completed in D1 via API
- Hide/minimize the iframe
- Update activeAppSessionsAtom

Also implement the Worker endpoint:
POST /api/app-sessions — create a new session
PATCH /api/app-sessions/:id — update status, state_summary

When the AppContainer receives a signalCompletion call from the app:
1. Call endAppSession
2. Store the completion summary
3. The summary will be included in the next Claude call via buildSystemPrompt
```

### Step 4.6 — Spike test: Penpal + sandbox

Before building the chess app, verify that Penpal works with the sandbox restrictions.

**Cursor prompt:**
```
Create a minimal test app to verify Penpal works with sandboxed iframes:

1. Create a file public/test-app.html that:
   - Imports Penpal from a CDN (https://unpkg.com/penpal/dist/penpal.min.js)
   - Calls connectToParent with methods:
     - initialize(config) → logs config, returns { success: true }
     - invokeTool(name, params) → returns { success: true, displayText: "Test tool called: " + name }
     - getState() → returns { raw: {}, display: "Test app running" }
     - destroy() → logs "destroyed"
   - Calls parent.notifyStateUpdate({ raw: {}, display: "Test app ready" }) after connecting

2. Create a test manifest with entry_url pointing to /test-app.html and one dummy tool

3. Register this test app via the /api/apps/register endpoint

4. In the chat, type "use the test app" — Claude should discover it via list_available_apps, and the iframe should load

This verifies the entire plugin lifecycle before we build real apps.
```

**Verify:** The test app iframe loads, Penpal connects, tool invocations round-trip through Claude. This is the critical validation — if this works, the architecture is sound.

---

## Phase 5: Chess app (3-4 hours)

### Step 5.1 — Scaffold the chess app as a separate project

Chess runs as a separate Cloudflare Pages project for origin isolation.

```bash
# From the chatbridge root (NOT inside app/)
mkdir apps
cd apps
npm create vite@latest chess -- --template react-ts
cd chess
npm install chess.js react-chessboard penpal
npm install -D tailwindcss @tailwindcss/vite
```

### Step 5.2 — Build the chess app

**Cursor prompt:**
```
Build the chess app in apps/chess/src/:

src/App.tsx — the main chess component:
1. On mount, connect to the parent platform via Penpal's connectToParent
2. Expose these AppMethods:
   - initialize(config) → set theme, prepare UI
   - invokeTool(toolName, params) → dispatch to the appropriate handler:
     * "start_game" → create a new Chess() instance, set player color and difficulty, return board state
     * "make_move" → validate and apply the move, if playing against AI make a random counter-move, return result
     * "get_board_state" → return FEN + human-readable summary
     * "analyze_position" → return legal moves + simple evaluation
   - getState() → return { raw: { fen, history, ... }, display: "human readable summary" }
   - destroy() → cleanup

3. Render a Chessboard component from react-chessboard:
   - Position from the Chess() instance's FEN
   - onPieceDrop handler that validates and applies moves
   - After each move, call platform.notifyStateUpdate with updated state
   - When game is over (checkmate, stalemate, draw), call platform.signalCompletion

4. Every ToolResult MUST include a displayText field with a human-readable description.
   Examples:
   - start_game: "New chess game started. You are playing as white. Board is in starting position."
   - make_move: "Move e4 played. White pawn moved to e4. Black to move. 1 move played so far."
   - get_board_state: "Position after 12 moves. White has slight material advantage. Legal moves for white: Nf3, Bc4, d4, ..."
   - analyze_position: "Position evaluation: roughly equal. Suggested moves: 1) Nf3 (develops knight) 2) d4 (controls center)"

The displayText is what Claude reads to understand the game state. Make it descriptive and natural.

Use Tailwind for styling. Dark theme that matches the platform. The board should be responsive and centered.
```

### Step 5.3 — Register the chess manifest

**Cursor prompt:**
```
Create a script apps/chess/register-manifest.ts (or a JSON file) with the chess app manifest:

{
  "id": "chess",
  "name": "Chess",
  "version": "1.0.0",
  "description": "Interactive chess game with AI analysis. Play chess against a computer opponent while the chatbot provides commentary and advice.",
  "author": "ChatBridge",
  "category": "games",
  "auth": { "type": "none" },
  "entry_url": "https://chatbridge-chess.pages.dev",  // Will be updated after deploy
  "iframe": {
    "width": "100%",
    "height": "500px",
    "sandbox": ["allow-scripts", "allow-forms"]
  },
  "tools": [
    {
      "name": "start_game",
      "description": "Start a new chess game. Call this when the user wants to play chess.",
      "parameters": {
        "type": "object",
        "properties": {
          "player_color": { "type": "string", "enum": ["white", "black"], "default": "white", "description": "Which color the player wants to play as" },
          "difficulty": { "type": "string", "enum": ["beginner", "intermediate", "advanced"], "default": "intermediate", "description": "AI opponent difficulty level" }
        }
      }
    },
    {
      "name": "make_move",
      "description": "Make a chess move using algebraic notation. Example: 'e2e4' moves pawn from e2 to e4.",
      "parameters": {
        "type": "object",
        "properties": {
          "move": { "type": "string", "description": "Move in algebraic notation (e.g., e2e4, Nf3, O-O for castling)" }
        },
        "required": ["move"]
      }
    },
    {
      "name": "get_board_state",
      "description": "Get the current board state including position, legal moves, and game status.",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "name": "analyze_position",
      "description": "Analyze the current chess position and suggest best moves with explanations.",
      "parameters": { "type": "object", "properties": {} }
    }
  ],
  "completion_events": ["game_over", "user_resigned", "draw_agreed"]
}
```

For local development, set `entry_url` to `http://localhost:5174` (the chess app's Vite dev server).

### Step 5.4 — Test the full chess lifecycle

Start both dev servers:

```bash
# Terminal 1: Platform
cd app && npm run dev

# Terminal 2: Chess app
cd apps/chess && npm run dev -- --port 5174
```

Register the chess app:
```bash
curl -X POST http://localhost:5173/api/apps/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @apps/chess/manifest.json
```

**Test sequence in the chat UI:**
1. Type "let's play chess" → Claude should call `list_available_apps`, then `start_game`
2. Chess board appears in the right panel
3. Make a move on the board → state updates
4. Type "what should I do here?" → Claude calls `get_board_state`, analyzes position
5. Play until checkmate → app calls `signalCompletion`
6. Type "how did that game go?" → Claude recalls the game summary

If any step fails, check the browser console for Penpal errors and the Worker logs for Claude API errors.

---

## Phase 6: App 2 and App 3 (3-4 hours)

### Step 6.1 — Build App 2 (simple, no auth)

**Implemented:** `apps/weather` (Vite on port **5175**). Choose alternatives: Flashcards or Nature ID if you prefer.

```bash
cd apps/weather   # already scaffolded in repo
npm install
npm run dev
```

**Cursor prompt:**
```
Build a weather dashboard app in apps/weather/:

It should:
1. Connect to parent via Penpal (same pattern as chess)
2. Implement invokeTool for:
   - "get_weather": accepts { location }, fetches from Open-Meteo API (free, no key), returns current temp, conditions, forecast
   - "get_forecast": accepts { location, days }, returns multi-day forecast
3. Render a simple weather card UI showing:
   - Current temperature (large number)
   - Weather condition (sunny, cloudy, rainy)
   - Wind speed and humidity
   - 3-day mini forecast
4. On data load, call platform.signalCompletion("data_loaded", "Weather for {location}: {temp}°F, {condition}")
5. Every ToolResult includes displayText: "Current weather in Austin, TX: 78°F, partly cloudy. Wind: 8 mph. Humidity: 45%."

Open-Meteo API (no key needed):
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true

Use a geocoding step or accept lat/lon. For simplicity, accept city names and use Open-Meteo's geocoding:
https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1
```

Create the manifest and register it (same pattern as chess).

### Step 6.2 — Build App 3 (OAuth2 + Spotify)

**Implemented:** `apps/spotify-app` (Vite on port **5176**) with [Spotify Web API](https://developer.spotify.com/documentation/web-api) and [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk).

```bash
cd apps/spotify-app
npm install
npm run dev
```

**Platform OAuth (Worker + `AppContainer`):**

- `GET /api/oauth/spotify/authorize?bridge_jwt=...&app_id=spotify&scope=...` — starts Spotify login (popup; `bridge_jwt` is the user’s ChatBridge JWT).
- `GET /api/oauth/spotify/callback` — exchanges code, encrypts tokens into D1 `app_tokens`, `postMessage` to opener, closes popup.
- `GET /api/oauth/spotify/token?app_id=spotify` — Bearer JWT; returns fresh access token (refreshes server-side).

**Secrets:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` in `app/.dev.vars` (see `app/.dev.vars.example`). Spotify Dashboard redirect URI: `http://localhost:5173/api/oauth/spotify/callback` (and production Worker origin).

**Penpal:** `requestAuth("spotify", scopes)` and `getOAuthAccessToken("spotify", appId)` on the platform parent.

**Optional alternative:** GitHub Issues OAuth (not implemented in this repo) — same pattern with GitHub’s token endpoints.

---

## Phase 7: Error handling and resilience (2 hours)

### Step 7.1 — Add error handling across the stack

**Cursor prompt:**
```
Add comprehensive error handling to ChatBridge:

1. Iframe load failures (src/components/apps/AppContainer.tsx):
   - Set a 5-second load timeout
   - On iframe onerror or timeout, show an error card with "App failed to load" and a retry button
   - Log the error for debugging

2. Tool call timeouts (src/hooks/useAppBridge.ts):
   - Set a 10-second timeout on Penpal invokeTool calls
   - On timeout, return a ToolResult with { success: false, error: "App did not respond in time", displayText: "The chess app took too long to respond. It may have encountered an error." }
   - Claude will receive this and explain the error to the user naturally

3. Claude API errors (src/workers/claude.ts):
   - Retry failed requests up to 3 times with exponential backoff (1s, 2s, 4s)
   - On final failure, return an SSE error event
   - The frontend shows a "Something went wrong. Try again." message

4. Circuit breaker (src/workers/index.ts):
   - Track per-app failure count in a Map
   - 3 failures in 5 minutes → mark app as "degraded", warn user before invoking
   - 10 failures → auto-disable for the session

5. Penpal connection drop (src/components/apps/AppContainer.tsx):
   - Listen for Penpal's connection.destroy event
   - Show "App disconnected" state with restart button
   - Store last known state summary for recovery

6. Graceful degradation:
   - If an app fails, the chat should continue working normally
   - The chatbot should acknowledge the failure: "It looks like the chess app ran into an issue. Would you like me to try again or do something else?"
```

---

## Phase 8: Durable Object WebSocket upgrade (2-3 hours)

### Step 8.1 — Implement the Chat Session Durable Object

**Cursor prompt:**
```
Implement the ChatSession Durable Object class in src/workers/chat-session.ts:

Use the Cloudflare durable-objects skill in Cursor for correct patterns.

The DO should:
1. Accept WebSocket upgrade requests
2. Use the Hibernatable WebSocket API (so idle connections don't incur duration charges)
3. Maintain per-session state in embedded SQLite:
   - session_messages: cache of conversation messages (avoids D1 roundtrip per turn)
   - active_apps: currently active app sessions with state summaries
   - pending_tool_calls: in-flight invocations awaiting iframe response

4. Handle these WebSocket message types from the client:
   - { type: "user_message", content: "..." }
     → Save to local SQLite + D1
     → Call Claude via AI Gateway
     → Stream response chunks back via ws.send()
     → If tool_use detected, send { type: "tool_invoke", ... }

   - { type: "tool_result", callId: "...", result: {...} }
     → Save to local SQLite + D1
     → Call Claude with updated history
     → Stream follow-up response

5. Implement webSocketClose and webSocketError handlers for cleanup

6. On DO eviction (idle ~30s), all state persists in ctx.storage.sql
   On wake, reconstruct in-memory state from storage

Export the class and add it to wrangler.jsonc as a Durable Object binding.

The Worker's /ws/chat/:conversationId route should:
1. Verify auth (JWT from query param or first WS message)
2. Get or create the DO instance using conversationId as the ID
3. Forward the request to the DO
```

### Step 8.2 — Update the frontend to use WebSocket

**Cursor prompt:**
```
Update src/hooks/useChat.ts to support WebSocket:

1. When a conversation is opened, establish a WebSocket connection to /ws/chat/{conversationId}
2. Send user messages via ws.send(JSON.stringify({ type: "user_message", content }))
3. Receive assistant chunks, tool invocations, and completion events via ws.onmessage
4. Keep the SSE-based /api/chat as a fallback if WebSocket fails to connect
5. Handle reconnection: if the WS drops, attempt to reconnect 3 times with backoff
6. On reconnect, the DO's persisted state means no messages are lost

The message handling logic is the same as the SSE version — just the transport changes.
```

---

## Phase 9: Polish (2-3 hours)

### Step 9.1 — UI polish

**Cursor prompt:**
```
Polish the ChatBridge UI:

1. Loading states:
   - Skeleton loaders for conversation list
   - Typing indicator (three bouncing dots) when waiting for AI
   - "Loading app..." spinner in the iframe container
   - Progress bar or shimmer effect on tool invocation

2. App container:
   - Smooth slide-in animation when iframe opens
   - Header bar with app name, minimize button, close button
   - Minimize collapses to a small chip at the bottom of the chat
   - Subtle border/shadow to visually separate app from chat

3. Message rendering:
   - Markdown rendering for assistant messages (install react-markdown)
   - Code blocks with syntax highlighting (install react-syntax-highlighter)
   - Tool invocation messages show as subtle system messages: "[Using Chess...]"
   - Smooth fade-in animation on new messages

4. Responsive layout:
   - On mobile/narrow screens, app iframe shows full-width below messages instead of side panel
   - Conversation sidebar collapses to a hamburger menu on mobile

5. Dark theme consistency across all components
```

### Step 9.2 — Multi-app routing

**Cursor prompt:**
```
Improve how Claude routes between multiple apps:

1. Update the system prompt to include clear instructions:
   "When the user's request could match multiple apps, ask for clarification.
    When the user's request doesn't match any app, answer directly without invoking tools.
    When an app session is active, prefer that app's tools for ambiguous requests."

2. Test these scenarios and verify correct behavior:
   - "let's play chess" → starts chess (clear match)
   - "what's the weather in Austin?" → starts weather (clear match)
   - "show me something fun" → asks for clarification (ambiguous)
   - "what's 2+2?" → answers directly (no app needed)
   - Mid-chess: "what should I do?" → uses chess's analyze_position (active app context)
   - "stop the chess game and check the weather" → closes chess, opens weather

3. If routing accuracy is poor, add few-shot examples to the system prompt showing correct behavior.
```

---

## Phase 10: Deploy (1-2 hours)

### Step 10.1 — Deploy the platform

```bash
cd app

# Apply migrations to production D1
npx wrangler d1 migrations apply chatbridge-db --remote

# Deploy the Worker + static assets
npx wrangler deploy
```

**Verify:** Visit `https://chatbridge.YOUR_SUBDOMAIN.workers.dev` — the login page should load.

### Step 10.2 — Deploy the apps

```bash
# Chess
cd apps/chess
npm run build
npx wrangler pages deploy dist --project-name chatbridge-chess

# Weather
cd apps/weather
npm run build
npx wrangler pages deploy dist --project-name chatbridge-weather

# Spotify app
cd apps/spotify-app
npm run build
npx wrangler pages deploy dist --project-name chatbridge-spotify
```

Each app gets a `*.pages.dev` URL. Note these URLs.

### Step 10.3 — Update manifests with production URLs

The manifests currently point to `localhost`. Update them to the deployed Pages URLs:

```bash
# Re-register each app with the production entry_url
curl -X POST https://chatbridge.YOUR_SUBDOMAIN.workers.dev/api/apps/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"chess","entry_url":"https://chatbridge-chess.pages.dev", ...}'
```

### Step 10.4 — Smoke test production

1. Register a new account on the deployed platform
2. Create a conversation
3. Send a basic chat message — verify streaming works
4. Type "let's play chess" — verify the chess iframe loads from `*.pages.dev`
5. Play a few moves, ask for advice mid-game
6. End the game, ask about the result — verify context retention
7. Switch to weather app — verify multi-app works
8. Check the AI Gateway dashboard — verify requests are logged with metadata

---

## Phase 11: Documentation and deliverables (2 hours)

### Step 11.1 — Developer documentation

**Cursor prompt:**
```
Create a docs/ directory with:

docs/README.md — Setup guide:
- Prerequisites (Node 20+, Cloudflare account, Anthropic key)
- Step-by-step local setup (clone, install, create CF resources, run dev)
- Environment variables reference
- How to deploy

docs/PLUGIN_API.md — Third-party developer guide:
- "Build your first ChatBridge app in 15 minutes"
- Manifest schema with all fields documented
- Penpal method signatures with TypeScript types
- Tool definition format with examples
- Completion signaling contract
- Local development workflow (point entry_url to localhost)
- Example: minimal app template

docs/ARCHITECTURE.md — Architecture overview:
- System diagram (copy from PRD)
- Tool invocation lifecycle (11 steps)
- State management strategy (D1 vs DO SQLite)
- AI Gateway integration
- Security model (iframe sandbox, CSP, content filtering)
```

### Step 11.2 — AI cost analysis

Go to the AI Gateway dashboard and export your analytics:

```
1. Navigate to: Cloudflare Dashboard → AI → AI Gateway → chatbridge-gateway
2. Screenshot the analytics dashboard showing:
   - Total requests
   - Token usage (input/output)
   - Cost per request
   - Cache hit rate
   - Latency distribution
3. Export the data for the cost analysis document
```

**Cursor prompt:**
```
Create docs/COST_ANALYSIS.md based on the AI Gateway analytics:

Section 1: Development & Testing Costs
- Pull actual numbers from the AI Gateway dashboard
- Total API calls, tokens consumed, total spend
- Cache hit rate and estimated savings

Section 2: Production Cost Projections
- Use the table from the PRD (100/1K/10K/100K users)
- Include AI Gateway optimization projections (cache: -15%, dynamic routing: -40%)
- State assumptions: 20 msgs/session, 10 sessions/user/month, 3K avg input tokens

Section 3: Cost Optimization Recommendations
- Lazy schema loading (implemented)
- AI Gateway caching (implemented)
- Dynamic routing: Haiku for simple, Sonnet for complex (stretch)
- Context summarization for long conversations (future)
```

### Step 11.3 — Demo video

Record a 3-5 minute video (use the script from chatbridge-video-script-v2.md):

```bash
# Suggested recording tools:
# - OBS Studio (free, screen recording + webcam)
# - Loom (easy, browser-based)
# - QuickTime (Mac built-in)
```

Show the slide deck on screen, walk through the architecture, then switch to the live app for a demo of the chess lifecycle.

### Step 11.4 — Social post

Post on X or LinkedIn:
- Brief description of ChatBridge
- Key features (AI chat + embedded apps + plugin system)
- Screenshot or short demo GIF
- Tag @GauntletAI
- Link to the deployed app

---

## Troubleshooting

### Common issues

| Problem | Likely cause | Fix |
|---|---|---|
| `wrangler dev` fails with binding errors | Missing D1/KV IDs in wrangler.jsonc | Run `wrangler d1 list` and `wrangler kv namespace list`, update IDs |
| Penpal connection times out | iframe sandbox too restrictive | Verify `allow-scripts` is in the sandbox attribute; check browser console for CSP errors |
| Claude doesn't call tools | Tools not in the tool array | Log the tool array being sent to Claude; verify manifests are in KV |
| SSE stream dies mid-response | Worker CPU timeout (10ms free tier) | Upgrade to Workers paid ($5/mo) for 30ms CPU limit |
| `SQLITE_BUSY` errors on D1 | Concurrent writes to same table | Batch writes; use DO as write serializer for hot paths |
| OAuth popup blocked | Browser popup blocker | Ensure `window.open()` is called from a user interaction (click handler, not async callback) |
| App iframe shows blank | Wrong entry_url or CORS issue | Check the iframe src in dev tools; verify the app is actually running at that URL |
| Claude hallucinates tool names | Stale tool schemas in context | Clear the conversation and start fresh; verify KV has the correct manifest |

### Useful debug commands

```bash
# Check D1 tables
npx wrangler d1 execute chatbridge-db --local --command "SELECT * FROM apps"

# Check KV contents
npx wrangler kv key list --binding APP_MANIFESTS --local

# Tail Worker logs in production
npx wrangler tail

# Check AI Gateway analytics
# Visit: https://dash.cloudflare.com → AI → AI Gateway → chatbridge-gateway
```

---

## Quick reference — all Cursor prompts as a checklist

Use this to track your progress. Check off each prompt as you complete it.

- [ ] Phase 0: wrangler.jsonc, vite.config.ts, project structure
- [ ] Phase 1: D1 migration, TypeScript types, Worker entry, auth routes, conversation CRUD
- [ ] Phase 2: Claude client, chat endpoint with SSE, tool result endpoint
- [ ] Phase 3: Jotai stores, auth pages, chat layout, SSE streaming hook, routing
- [ ] Phase 4: App registration API, list_available_apps tool, AppContainer, useAppBridge, useAppSession, Penpal spike test
- [ ] Phase 5: Chess app (separate project), manifest registration, full lifecycle test
- [ ] Phase 6: App 2 (weather), App 3 (Spotify OAuth + Web Playback)
- [ ] Phase 7: Error handling (timeouts, circuit breaker, graceful degradation)
- [ ] Phase 8: Durable Object WebSocket, frontend WS support
- [ ] Phase 9: UI polish, multi-app routing
- [ ] Phase 10: Deploy platform + all apps, smoke test, update manifests
- [ ] Phase 11: Documentation, cost analysis, demo video, social post