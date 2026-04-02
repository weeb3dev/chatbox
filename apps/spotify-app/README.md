# ChatBridge Spotify app

Requires:

- Spotify Developer app with **Web API** and **Web Playback SDK** enabled.
- Redirect URI: `http://localhost:5173/api/oauth/spotify/callback` (plus your production Worker origin).
- Platform secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` in `app/.dev.vars` or Wrangler secrets.

**Premium** is required for Web Playback SDK and most playback control endpoints. See [Web API](https://developer.spotify.com/documentation/web-api) and [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) terms (non-commercial demo use unless you have Spotify approval).

```bash
npm install
npm run dev
```

Register the manifest against the ChatBridge API (`POST /api/apps/register`) with the correct `entry_url`.
