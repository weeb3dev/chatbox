# ChatBridge

An AI chat platform where third-party apps run inside sandboxed iframes and interact with Claude through a tool-use protocol. Users chat naturally; Claude discovers and invokes app tools on their behalf, creating a seamless bridge between conversation and interactive applications.

Built on Cloudflare Workers, D1, Durable Objects, and AI Gateway.

## Quick Start

```bash
cd app
npm install
cp .dev.vars.example .dev.vars   # fill in your keys
npx wrangler d1 migrations apply chatbridge-db --local
npm run dev                      # http://localhost:5173
```

See [docs/README.md](docs/README.md) for full setup instructions including Cloudflare resource creation and app registration.

## Documentation

| Doc | Description |
|-----|-------------|
| [Setup Guide](docs/README.md) | Prerequisites, local dev, environment variables, deployment |
| [Architecture](docs/ARCHITECTURE.md) | System diagram, request flow, state management, security model |
| [Plugin API](docs/PLUGIN_API.md) | Build a ChatBridge app: manifest schema, Penpal contract, tool format |
| [Cost Analysis](docs/COST_ANALYSIS.md) | AI Gateway analytics, production cost projections, optimization strategies |

## Bundled Apps

| App | Port (dev) | Auth | Description |
|-----|-----------|------|-------------|
| [Chess](../apps/chess) | 5174 | None | Interactive chess with AI commentary |
| [Weather](../apps/weather) | 5175 | None | Current conditions and forecast via Open-Meteo |
| [Spotify](../apps/spotify-app) | 5176 | OAuth2 | Search, playback control, Web Playback SDK |

## License

See the root [LICENSE](../LICENSE) file.
