# ChatBridge Plugin API

Build third-party apps that run inside ChatBridge's AI chat interface. Your app renders in a sandboxed iframe; Claude discovers it, invokes its tools, and relays results back to the user conversationally.

## Quick Start: Build Your First App in 15 Minutes

### 1. Create a single HTML file

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>My App</title>
  <script src="https://unpkg.com/penpal/dist/penpal.min.js"></script>
</head>
<body>
  <div id="app">Loading...</div>
  <script>
    const connection = Penpal.connectToParent({
      methods: {
        async initialize(config) {
          document.getElementById('app').textContent = 'Ready! Session: ' + config.sessionId;
        },
        async invokeTool(toolName, params) {
          if (toolName === 'greet') {
            const name = params.name || 'world';
            document.getElementById('app').textContent = 'Hello, ' + name + '!';
            return {
              success: true,
              data: { greeting: 'Hello, ' + name + '!' },
              displayText: 'Greeted ' + name + ' successfully.'
            };
          }
          return { success: false, error: 'Unknown tool: ' + toolName };
        },
        async getState() {
          return { raw: {}, display: 'App is running' };
        },
        async destroy() {
          document.getElementById('app').textContent = 'Goodbye!';
        }
      }
    });

    connection.promise.then(function (parent) {
      parent.notifyStateUpdate({ raw: {}, display: 'App loaded and ready' });
    });
  </script>
</body>
</html>
```

### 2. Write a manifest

```json
{
  "id": "my-app",
  "name": "My App",
  "version": "1.0.0",
  "description": "A minimal ChatBridge app that greets people.",
  "author": "You",
  "category": "utilities",
  "auth": { "type": "none" },
  "entry_url": "http://localhost:3000",
  "iframe": {
    "width": "100%",
    "height": "200px",
    "sandbox": ["allow-scripts"]
  },
  "tools": [
    {
      "name": "greet",
      "description": "Greet someone by name.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The name of the person to greet"
          }
        },
        "required": ["name"]
      }
    }
  ],
  "completion_events": []
}
```

### 3. Serve and register

```bash
# Serve the HTML (any static server works)
npx serve . -l 3000

# Register with the platform
curl -X POST http://localhost:5173/api/apps/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @manifest.json
```

### 4. Test it

Type "greet Alice" in the ChatBridge chat. Claude discovers your app via `list_available_apps`, invokes the `greet` tool, and your iframe renders the greeting.

---

## Manifest Schema

The manifest is a JSON object registered with `POST /api/apps/register`. All fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier (lowercase, hyphens ok). Must be unique across all registered apps. |
| `name` | `string` | Yes | Human-readable display name. |
| `version` | `string` | Yes | Semver version string. |
| `description` | `string` | Yes | One-line description. Claude reads this to decide when to use the app. Make it descriptive. |
| `author` | `string` | Yes | Author or organization name. |
| `category` | `string` | Yes | Category slug: `games`, `utilities`, `media`, `productivity`, etc. |
| `auth` | `object` | Yes | Authentication config. See [Auth Types](#auth-types). |
| `entry_url` | `string` | Yes | URL to the app's HTML entry point. Loaded as the iframe `src`. |
| `iframe` | `object` | Yes | Iframe display config. See [Iframe Config](#iframe-config). |
| `tools` | `array` | Yes | Array of tool definitions. See [Tools](#tool-definition-format). |
| `completion_events` | `string[]` | Yes | Event names the app may emit via `signalCompletion`. Can be empty `[]`. |

### Auth Types

```typescript
interface AppManifestAuth {
  type: "none" | "api_key" | "oauth2";
  clientId?: string;          // oauth2 only
  authorizationUrl?: string;  // oauth2 only
  tokenUrl?: string;          // oauth2 only
  scopes?: string[];          // oauth2 only
}
```

**`"none"`** -- No authentication required. The simplest option.

```json
{ "type": "none" }
```

**`"oauth2"`** -- Platform-managed OAuth2 flow. The platform handles the popup, token exchange, and refresh. Your app calls `requestAuth` and `getOAuthAccessToken` via Penpal.

```json
{
  "type": "oauth2",
  "authorizationUrl": "https://accounts.spotify.com/authorize",
  "tokenUrl": "https://accounts.spotify.com/api/token",
  "scopes": ["user-read-playback-state", "streaming"]
}
```

### Iframe Config

```typescript
interface AppManifestIframe {
  width: string;    // CSS width, e.g. "100%"
  height: string;   // CSS height, e.g. "500px"
  sandbox: string[];
}
```

Sandbox values are applied to the iframe's `sandbox` attribute. Minimum required:

- `allow-scripts` -- Always required (your app runs JavaScript).

Common additions:

- `allow-forms` -- If your app has form submissions.
- `allow-same-origin` -- If your app needs to call external APIs from the iframe (e.g., Open-Meteo, Spotify Web API). Without this, `fetch` may be restricted.
- `allow-popups` + `allow-popups-to-escape-sandbox` -- If your app needs to open popups (e.g., OAuth flows).

---

## Tool Definition Format

Each tool in the `tools` array describes one action Claude can invoke in your app:

```typescript
interface AppManifestTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      default?: string;
    }>;
    required?: string[];
  };
}
```

### Tips for good tool definitions

- **`description`** is what Claude reads to decide when to call the tool. Be specific: "Start a new chess game" is better than "Start".
- **`parameters.properties`** -- Each property `description` helps Claude fill in the right values. Include examples.
- **`required`** -- List parameters that must be provided. Claude will ask the user for them if missing.
- **`enum`** -- Constrain values when there's a fixed set of options.
- **`default`** -- Document the default so Claude knows what happens when a parameter is omitted.

### Example: Chess tools

```json
{
  "name": "start_game",
  "description": "Start a new chess game. Call this when the user wants to play chess.",
  "parameters": {
    "type": "object",
    "properties": {
      "player_color": {
        "type": "string",
        "enum": ["white", "black"],
        "default": "white",
        "description": "Which color the player wants to play as"
      },
      "difficulty": {
        "type": "string",
        "enum": ["beginner", "intermediate", "advanced"],
        "default": "intermediate",
        "description": "AI opponent difficulty level"
      }
    }
  }
}
```

```json
{
  "name": "make_move",
  "description": "Make a chess move using algebraic notation. Example: 'e2e4' moves pawn from e2 to e4.",
  "parameters": {
    "type": "object",
    "properties": {
      "move": {
        "type": "string",
        "description": "Move in algebraic notation (e.g., e2e4, Nf3, O-O for castling)"
      }
    },
    "required": ["move"]
  }
}
```

---

## Penpal Contract

ChatBridge communicates with your app via [Penpal](https://github.com/nicholascloud/penpal), a promise-based postMessage library. Your app implements `AppMethods`; the platform provides `PlatformMethods`.

### AppMethods (your app implements these)

```typescript
interface AppMethods {
  initialize(config: AppInitConfig): Promise<void>;
  invokeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  getState(): Promise<AppStateSummary>;
  destroy(): Promise<void>;
}
```

| Method | When it's called | What to do |
|--------|-----------------|------------|
| `initialize(config)` | Immediately after Penpal connects. | Set up your UI. `config` contains `sessionId`, `theme` ("light" or "dark"), and `locale`. |
| `invokeTool(toolName, params)` | When Claude calls one of your tools. | Execute the tool logic, update your UI, and return a `ToolResult`. |
| `getState()` | When the platform needs a snapshot of your app's state. | Return an `AppStateSummary` with both machine-readable `raw` and human-readable `display` data. |
| `destroy()` | When the user closes the app or the session ends. | Clean up resources, listeners, timers. |

### PlatformMethods (the platform provides these)

```typescript
interface PlatformMethods {
  notifyStateUpdate(state: AppStateSummary): Promise<void>;
  signalCompletion(event: string, summary: string): Promise<void>;
  requestResize(height: number): Promise<void>;
  requestAuth(provider: string, scopes: string[]): Promise<AuthResult>;
  getOAuthAccessToken(provider: string, appId: string): Promise<OAuthAccessTokenResult>;
}
```

| Method | When to call it | What it does |
|--------|----------------|--------------|
| `notifyStateUpdate(state)` | After any meaningful state change in your app. | Updates the platform's cached state. The `display` field is included in Claude's system prompt so it has context about what your app is showing. |
| `signalCompletion(event, summary)` | When a logical unit of work is done (game over, data loaded, etc.). | Ends the app session. `event` must be one of your manifest's `completion_events`. `summary` is a human-readable string Claude uses to discuss the outcome. |
| `requestResize(height)` | When your app needs more or less vertical space. | Adjusts the iframe container height (in pixels). |
| `requestAuth(provider, scopes)` | When your app needs OAuth tokens. | Opens the platform's OAuth popup. Returns `{ success: true }` on approval. |
| `getOAuthAccessToken(provider, appId)` | After auth succeeds, whenever you need a fresh token. | Returns `{ success, accessToken, expiresAt }`. The platform handles refresh automatically. |

### Connection setup (your app)

```javascript
import { connectToParent } from 'penpal';

const connection = connectToParent({
  methods: {
    initialize: async (config) => { /* ... */ },
    invokeTool: async (toolName, params) => { /* ... */ },
    getState: async () => { /* ... */ },
    destroy: async () => { /* ... */ },
  },
});

const platform = await connection.promise;
// Now you can call platform.notifyStateUpdate, platform.signalCompletion, etc.
```

---

## ToolResult

Every `invokeTool` call must return a `ToolResult`:

```typescript
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  displayText?: string;
}
```

| Field | Description |
|-------|-------------|
| `success` | `true` if the tool executed correctly, `false` on error. |
| `data` | Arbitrary JSON payload with the tool's output. |
| `error` | Error message when `success` is `false`. Claude reads this to explain the failure to the user. |
| `displayText` | **Important.** Human-readable summary of what happened. Claude uses this to formulate its response. Without it, Claude only sees `data` (which may be opaque). |

### Why `displayText` matters

Claude's response quality depends heavily on `displayText`. Compare:

**Without displayText** -- Claude sees `{ success: true, data: { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" } }` and has to decode FEN notation.

**With displayText** -- Claude sees `"Move e4 played. White pawn moved to e4. Black to move. 1 move played so far."` and can respond naturally: "I played e4, opening with the King's Pawn. Your turn!"

Always include `displayText` with a natural-language description of the result.

---

## State Management

### AppStateSummary

```typescript
interface AppStateSummary {
  raw: Record<string, unknown>;
  display: string;
}
```

- **`raw`** -- Machine-readable state your app can use to restore itself (e.g., FEN string, search results, player configuration). Stored in the platform's database.
- **`display`** -- Human-readable summary injected into Claude's system prompt. This gives Claude ongoing context about your app's current state between tool calls.

Call `platform.notifyStateUpdate(state)` after every meaningful change (move made, data loaded, playback started, etc.).

### Completion Signaling

When a logical unit of work finishes, call `platform.signalCompletion(event, summary)`:

```javascript
platform.signalCompletion('game_over', 'White wins by checkmate after 34 moves.');
```

- `event` must match one of the strings in your manifest's `completion_events`.
- `summary` is stored and included in Claude's context for the rest of the conversation, so the user can ask "how did that game go?" after the app closes.

---

## OAuth2 Apps

For apps that need user authorization (Spotify, GitHub, etc.), the platform manages the full OAuth2 flow.

### Manifest auth config

```json
{
  "auth": {
    "type": "oauth2",
    "authorizationUrl": "https://accounts.spotify.com/authorize",
    "tokenUrl": "https://accounts.spotify.com/api/token",
    "scopes": ["user-read-playback-state", "streaming"]
  }
}
```

### Flow from your app

```javascript
const platform = await connection.promise;

// 1. Request auth -- opens popup
const authResult = await platform.requestAuth('spotify', [
  'user-read-playback-state',
  'streaming'
]);

if (!authResult.success) {
  return { success: false, error: 'User denied Spotify access' };
}

// 2. Get access token
const tokenResult = await platform.getOAuthAccessToken('spotify', 'spotify');
if (!tokenResult.success) {
  return { success: false, error: tokenResult.error };
}

// 3. Use the token
const response = await fetch('https://api.spotify.com/v1/me/player', {
  headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
});
```

The platform stores tokens encrypted in D1 and handles refresh automatically. Your app never sees the refresh token.

### Platform-side requirements

The platform operator needs to:

1. Register OAuth client credentials with the provider (e.g., Spotify Developer Dashboard).
2. Store `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` as wrangler secrets.
3. Add the callback URL to the provider's allowed redirect URIs: `https://<worker-origin>/api/oauth/spotify/callback`.

---

## Local Development

### Point entry_url to localhost

During development, override `entry_url` when registering:

```bash
curl -X POST http://localhost:5173/api/apps/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq '.entry_url = "http://localhost:3000"' manifest.json)"
```

### Iframe sandbox and CORS

- The iframe loads your app's `entry_url` directly. No CORS headers are needed on your app's HTML.
- If your app calls external APIs from the iframe (e.g., Open-Meteo), you need `allow-same-origin` in the sandbox to avoid CORS restrictions inside the iframe.
- Penpal uses `postMessage` which works across origins without CORS.

### Dev server recommendations

Any static server works. For Vite-based apps:

```bash
npm create vite@latest my-chatbridge-app -- --template react-ts
cd my-chatbridge-app
npm install penpal
npm run dev -- --port 3000
```

---

## Minimal App Template

A complete, copy-pasteable starting point. Save as `index.html` and serve with any static server:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ChatBridge App</title>
  <script src="https://unpkg.com/penpal/dist/penpal.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; padding: 16px; background: #1a1a2e; color: #e0e0e0; }
    #output { padding: 12px; border-radius: 8px; background: #16213e; min-height: 60px; }
  </style>
</head>
<body>
  <div id="output">Connecting to ChatBridge...</div>
  <script>
    let state = { initialized: false };

    const connection = Penpal.connectToParent({
      methods: {
        async initialize(config) {
          state.initialized = true;
          state.sessionId = config.sessionId;
          state.theme = config.theme;
          render('Ready! Theme: ' + config.theme);
        },

        async invokeTool(toolName, params) {
          switch (toolName) {
            // Add your tool handlers here
            default:
              return { success: false, error: 'Unknown tool: ' + toolName };
          }
        },

        async getState() {
          return {
            raw: state,
            display: state.initialized ? 'App is running' : 'Not initialized'
          };
        },

        async destroy() {
          state = { initialized: false };
          render('Session ended.');
        }
      }
    });

    connection.promise.then(function (parent) {
      window._platform = parent;
      parent.notifyStateUpdate({ raw: state, display: 'App loaded' });
    });

    function render(text) {
      document.getElementById('output').textContent = text;
    }
  </script>
</body>
</html>
```
