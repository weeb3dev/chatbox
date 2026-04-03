# ChatBridge Setup Guide

## Prerequisites

- **Node.js** v20+ and npm
- **Cloudflare account** (Workers paid plan recommended for 30ms CPU limit; free tier's 10ms limit may truncate streaming responses)
- **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/)
- **wrangler CLI** (installed as a dev dependency, or globally via `npm i -g wrangler`)
- **Git**

## Local Setup

### 1. Clone and install

```bash
git clone <your-fork-url> chatbridge
cd chatbridge/app
npm install
```

### 2. Create environment secrets

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and fill in your keys:

```
ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=any-random-string-here
CF_AIG_TOKEN=your-ai-gateway-token
```

The Spotify keys are only needed if you plan to run the Spotify app (Phase 6):

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

### 3. Create Cloudflare resources

```bash
# D1 database
npx wrangler d1 create chatbridge-db

# KV namespace
npx wrangler kv namespace create APP_MANIFESTS
```

Both commands print IDs. Update `wrangler.jsonc` with the real IDs (replace the existing `database_id` and KV `id` values).

### 4. Create the AI Gateway

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > AI > AI Gateway
2. Create a gateway named `chatbridge-gateway`
3. Note your Account ID and Gateway ID
4. Enable authentication on the gateway
5. Store the gateway token: `npx wrangler secret put CF_AIG_TOKEN`

Update `wrangler.jsonc` `vars` with your `CF_ACCOUNT_ID` and `AI_GATEWAY_ID`.

### 5. Apply the D1 migration

```bash
npx wrangler d1 migrations apply chatbridge-db --local
```

### 6. Store production secrets

For deployed environments (not needed for local dev with `.dev.vars`):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put CF_AIG_TOKEN
npx wrangler secret put SPOTIFY_CLIENT_ID      # optional
npx wrangler secret put SPOTIFY_CLIENT_SECRET   # optional
```

## Environment Variables Reference

| Variable | Source | Required | Description |
|----------|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | `.dev.vars` / `wrangler secret` | Yes | Anthropic API key for Claude |
| `JWT_SECRET` | `.dev.vars` / `wrangler secret` | Yes | HMAC key for signing JWTs |
| `CF_AIG_TOKEN` | `.dev.vars` / `wrangler secret` | Yes | Cloudflare AI Gateway auth token |
| `CF_ACCOUNT_ID` | `wrangler.jsonc` `[vars]` | Yes | Cloudflare account ID |
| `AI_GATEWAY_ID` | `wrangler.jsonc` `[vars]` | Yes | AI Gateway name (default: `chatbridge-gateway`) |
| `SPOTIFY_CLIENT_ID` | `.dev.vars` / `wrangler secret` | No | Spotify app client ID (for Spotify app) |
| `SPOTIFY_CLIENT_SECRET` | `.dev.vars` / `wrangler secret` | No | Spotify app client secret |

## Running Dev

### Platform

```bash
cd app
npm run dev
# Runs at http://localhost:5173
```

### Apps (each in a separate terminal)

```bash
cd apps/chess && npm install && npm run dev -- --port 5174
cd apps/weather && npm install && npm run dev -- --port 5175
cd apps/spotify-app && npm install && npm run dev -- --port 5176
```

### Port assignments

| Service | Port |
|---------|------|
| ChatBridge platform | 5173 |
| Chess app | 5174 |
| Weather app | 5175 |
| Spotify app | 5176 |

## Registering Apps Locally

After the platform and an app dev server are running, register the app with a local `entry_url`:

```bash
# Get a JWT first
TOKEN=$(curl -s -X POST http://localhost:5173/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}' | jq -r '.token')

# Register the chess app (override entry_url for local dev)
curl -X POST http://localhost:5173/api/apps/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq '.entry_url = "http://localhost:5174"' ../apps/chess/manifest.json)"
```

Repeat for weather (port 5175) and spotify (port 5176).

## Deployment

### 1. Apply migrations to production D1

```bash
cd app
npx wrangler d1 migrations apply chatbridge-db --remote
```

### 2. Deploy the platform Worker

```bash
npx wrangler deploy
```

The platform deploys to `https://chatbridge.<your-subdomain>.workers.dev`.

### 3. Deploy each app to Cloudflare Pages

```bash
cd apps/chess && npm run build
npx wrangler pages deploy dist --project-name chatbridge-chess

cd apps/weather && npm run build
npx wrangler pages deploy dist --project-name chatbridge-weather

cd apps/spotify-app && npm run build
npx wrangler pages deploy dist --project-name chatbridge-spotify
```

Each app gets a `*.pages.dev` URL.

### 4. Re-register apps with production URLs

```bash
curl -X POST https://chatbridge.<subdomain>.workers.dev/api/apps/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @apps/chess/manifest.json
```

The `manifest.json` files already contain production `entry_url` values. If you modified them for local dev, revert before registering against production.

### 5. Spotify OAuth redirect URI

Add your production Worker origin to the Spotify app's redirect URIs in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

```
https://chatbridge.<subdomain>.workers.dev/api/oauth/spotify/callback
```

## Key Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Cloudflare bindings (D1, KV, DO, vars) |
| `.dev.vars.example` | Template for local secrets |
| `migrations/0001_initial.sql` | D1 schema (6 tables, 4 indexes) |
| `src/workers/index.ts` | Hono Worker entry point and route wiring |
| `src/workers/chat-session.ts` | Durable Object for WebSocket chat sessions |
| `src/workers/claude.ts` | Claude API client via AI Gateway |
| `src/types/index.ts` | All TypeScript interfaces |
