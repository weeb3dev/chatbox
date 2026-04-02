import { Hono } from "hono";
import type { Env } from "../../types";
import {
  verifyJWT,
  encryptAppToken,
  decryptAppToken,
} from "../lib/crypto";
import { authMiddleware } from "../middleware/auth";

const SPOTIFY_AUTH = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";

const DEFAULT_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
].join(" ");

const OAUTH_STATE_PREFIX = "oauth:spotify:state:";

type SpotifyOAuthApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

function redirectUriFromRequest(url: string): string {
  const u = new URL(url);
  return `${u.origin}/api/oauth/spotify/callback`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  const b64 = btoa(raw);
  return `Basic ${b64}`;
}

async function spotifyTokenExchange(
  env: Env,
  body: Record<string, string>,
  redirectUri?: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
} | null> {
  const cid = env.SPOTIFY_CLIENT_ID;
  const sec = env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !sec) return null;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    params.set(k, v);
  }
  if (redirectUri) {
    params.set("redirect_uri", redirectUri);
  }

  const res = await fetch(SPOTIFY_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(cid, sec),
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error("Spotify token error:", res.status, t);
    return null;
  }

  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  }>;
}

function oauthPopupHtml(
  origin: string,
  appId: string,
  success: boolean,
  error?: string,
): string {
  const appJs = JSON.stringify(appId);
  const originJs = JSON.stringify(origin);
  const successJs = success ? "true" : "false";
  const errJs = JSON.stringify(error ?? "");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Spotify</title></head><body><script>
(function(){
  var o = ${originJs};
  var msg = { type: "chatbridge-oauth", provider: "spotify", appId: ${appJs}, success: ${successJs}, error: ${errJs} };
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, o);
    }
  } catch (e) {}
  window.close();
})();
</script><p style="font-family:sans-serif">You can close this window.</p></body></html>`;
}

const spotify = new Hono<SpotifyOAuthApp>();

/** Start OAuth (JWT in query — popup cannot send Authorization header). */
spotify.get("/authorize", async (c) => {
  const bridgeJwt = c.req.query("bridge_jwt");
  const appId = c.req.query("app_id");
  const scopeParam = c.req.query("scope");

  if (!bridgeJwt || !appId) {
    return c.text("Missing bridge_jwt or app_id", 400);
  }

  const payload = await verifyJWT(bridgeJwt, c.env.JWT_SECRET);
  if (!payload) {
    return c.text("Invalid or expired session token", 403);
  }

  const cid = c.env.SPOTIFY_CLIENT_ID;
  if (!cid) {
    return c.text("Spotify OAuth is not configured (SPOTIFY_CLIENT_ID)", 503);
  }

  const scopes = (scopeParam?.trim() || DEFAULT_SCOPES).replace(/,/g, " ");
  const state = crypto.randomUUID();
  const statePayload = JSON.stringify({
    userId: payload.userId,
    appId,
    scopes,
  });

  await c.env.APP_MANIFESTS.put(`${OAUTH_STATE_PREFIX}${state}`, statePayload, {
    expirationTtl: 600,
  });

  const redir = redirectUriFromRequest(c.req.url);
  const authUrl = new URL(SPOTIFY_AUTH);
  authUrl.searchParams.set("client_id", cid);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redir);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("show_dialog", "false");

  return c.redirect(authUrl.toString(), 302);
});

spotify.get("/callback", async (c) => {
  const err = c.req.query("error");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const origin = new URL(c.req.url).origin;

  let appIdHint = "";
  if (state) {
    const st = await c.env.APP_MANIFESTS.get(`${OAUTH_STATE_PREFIX}${state}`);
    if (st) {
      try {
        appIdHint =
          (JSON.parse(st) as { appId?: string }).appId ?? "";
      } catch {
        /* ignore */
      }
    }
  }

  if (err) {
    const desc = c.req.query("error_description") ?? err;
    return c.html(
      oauthPopupHtml(origin, appIdHint, false, String(desc)),
      200,
    );
  }

  if (!code || !state) {
    return c.html(
      oauthPopupHtml(origin, "", false, "Missing code or state"),
      200,
    );
  }

  const raw = await c.env.APP_MANIFESTS.get(`${OAUTH_STATE_PREFIX}${state}`);
  if (!raw) {
    return c.html(oauthPopupHtml(origin, "", false, "Invalid or expired state"), 200);
  }

  let parsed: { userId: string; appId: string; scopes: string };
  try {
    parsed = JSON.parse(raw) as { userId: string; appId: string; scopes: string };
  } catch {
    return c.html(oauthPopupHtml(origin, "", false, "Corrupt OAuth state"), 200);
  }

  const redir = redirectUriFromRequest(c.req.url);
  const tokenJson = await spotifyTokenExchange(
    c.env,
    {
      grant_type: "authorization_code",
      code,
    },
    redir,
  );

  if (!tokenJson?.access_token) {
    return c.html(
      oauthPopupHtml(origin, parsed.appId, false, "Token exchange failed"),
      200,
    );
  }

  const refreshTok = tokenJson.refresh_token;
  if (!refreshTok) {
    return c.html(
      oauthPopupHtml(
        origin,
        parsed.appId,
        false,
        "Spotify did not return a refresh token",
      ),
      200,
    );
  }

  const secret = c.env.JWT_SECRET;
  const accessEnc = await encryptAppToken(tokenJson.access_token, secret);
  const refreshEnc = await encryptAppToken(refreshTok, secret);
  const expiresAt = new Date(
    Date.now() + tokenJson.expires_in * 1000,
  ).toISOString();

  const existing = await c.env.DB.prepare(
    "SELECT id FROM app_tokens WHERE user_id = ? AND app_id = ? LIMIT 1",
  )
    .bind(parsed.userId, parsed.appId)
    .first<{ id: string }>();

  if (existing?.id) {
    await c.env.DB.prepare(
      `UPDATE app_tokens SET
        access_token_enc = ?,
        refresh_token_enc = ?,
        scopes = ?,
        expires_at = ?
      WHERE id = ?`,
    )
      .bind(
        accessEnc,
        refreshEnc,
        tokenJson.scope ?? parsed.scopes,
        expiresAt,
        existing.id,
      )
      .run();
  } else {
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO app_tokens (id, user_id, app_id, access_token_enc, refresh_token_enc, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        parsed.userId,
        parsed.appId,
        accessEnc,
        refreshEnc,
        tokenJson.scope ?? parsed.scopes,
        expiresAt,
      )
      .run();
  }

  return c.html(oauthPopupHtml(origin, parsed.appId, true), 200);
});

spotify.use("/token", authMiddleware);

spotify.get("/token", async (c) => {
  const userId = c.get("userId");
  const appId = c.req.query("app_id");
  if (!appId) {
    return c.json({ error: "Missing app_id" }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, access_token_enc, refresh_token_enc, expires_at, scopes
     FROM app_tokens WHERE user_id = ? AND app_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId, appId)
    .first<{
      id: string;
      access_token_enc: string;
      refresh_token_enc: string;
      expires_at: string;
      scopes: string | null;
    }>();

  if (!row) {
    return c.json({ success: false, error: "not_linked" }, 404);
  }

  const secret = c.env.JWT_SECRET;
  let accessToken = await decryptAppToken(row.access_token_enc, secret);
  const expiresMs = new Date(row.expires_at).getTime();
  const skewMs = 60_000;

  if (Date.now() + skewMs >= expiresMs) {
    const refreshPlain = await decryptAppToken(row.refresh_token_enc, secret);
    const refreshed = await spotifyTokenExchange(c.env, {
      grant_type: "refresh_token",
      refresh_token: refreshPlain,
    });

    if (!refreshed?.access_token) {
      return c.json(
        { success: false, error: "refresh_failed" },
        401,
      );
    }

    accessToken = refreshed.access_token;
    const newAccessEnc = await encryptAppToken(accessToken, secret);
    let newRefreshEnc = row.refresh_token_enc;
    if (refreshed.refresh_token) {
      newRefreshEnc = await encryptAppToken(refreshed.refresh_token, secret);
    }
    const newExpires = new Date(
      Date.now() + refreshed.expires_in * 1000,
    ).toISOString();

    await c.env.DB.prepare(
      `UPDATE app_tokens SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, scopes = COALESCE(?, scopes) WHERE id = ?`,
    )
      .bind(
        newAccessEnc,
        newRefreshEnc,
        newExpires,
        refreshed.scope ?? null,
        row.id,
      )
      .run();

    return c.json({
      success: true,
      accessToken,
      expiresAt: Math.floor(new Date(newExpires).getTime() / 1000),
    });
  }

  return c.json({
    success: true,
    accessToken,
    expiresAt: Math.floor(expiresMs / 1000),
  });
});

export default spotify;
