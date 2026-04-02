import { useState, useEffect, useRef, useCallback } from "react";
import { connect, WindowMessenger } from "penpal";

const APP_ID = "spotify";

const OAUTH_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
];

interface AppStateSummary {
  raw: Record<string, unknown>;
  display: string;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  displayText?: string;
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

interface OAuthAccessTokenResult {
  success: boolean;
  accessToken?: string;
  expiresAt?: number;
  error?: string;
}

interface PlatformMethods {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [index: string]: PlatformMethods | Function;
  notifyStateUpdate(state: AppStateSummary): Promise<void>;
  signalCompletion(event: string, summary: string): Promise<void>;
  requestResize(height: number): Promise<void>;
  requestAuth(provider: string, scopes: string[]): Promise<AuthResult>;
  getOAuthAccessToken(
    provider: string,
    appId: string,
  ): Promise<OAuthAccessTokenResult>;
}

type WebPlayer = {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(
    event: string,
    cb: (payload: { device_id?: string; message?: string }) => void,
  ): boolean;
  removeListener(event: string): boolean;
  getCurrentState(): Promise<unknown>;
};

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => WebPlayer;
    };
  }
}

async function spotifyFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: HeadersInit = {
    Authorization: `Bearer ${token}`,
    ...init?.headers,
  };
  if (init?.body !== undefined && init.body !== null) {
    (headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers,
  });
}

export default function App() {
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "error"
  >("connecting");
  const [sdkReady, setSdkReady] = useState(false);
  const [playerStatus, setPlayerStatus] = useState(
    "Connect Spotify via chat, then use Web Playback (Premium).",
  );
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);

  const parentRef = useRef<PlatformMethods | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const playerRef = useRef<WebPlayer | null>(null);
  const nowPlayingRef = useRef<string | null>(null);
  nowPlayingRef.current = nowPlaying;

  const getStateSummary = useCallback((): AppStateSummary => {
    return {
      raw: {
        deviceId: deviceIdRef.current,
        nowPlaying: nowPlayingRef.current,
      },
      display: nowPlayingRef.current ?? "Spotify app ready",
    };
  }, []);

  const notifyParent = useCallback(async () => {
    if (parentRef.current) {
      try {
        await parentRef.current.notifyStateUpdate(getStateSummary());
      } catch {
        /* ignore */
      }
    }
  }, [getStateSummary]);

  const ensureAccessToken = useCallback(async (): Promise<
    string | null
  > => {
    const parent = parentRef.current;
    if (!parent) return null;
    let r = await parent.getOAuthAccessToken("spotify", APP_ID);
    if (r.success && r.accessToken) return r.accessToken;
    const auth = await parent.requestAuth("spotify", OAUTH_SCOPES);
    if (!auth.success) return null;
    r = await parent.getOAuthAccessToken("spotify", APP_ID);
    return r.accessToken ?? null;
  }, []);

  const withToken = useCallback(
    async (fn: (token: string) => Promise<ToolResult>): Promise<ToolResult> => {
      const token = await ensureAccessToken();
      if (!token) {
        return {
          success: false,
          error: "not_authorized",
          displayText:
            "Spotify is not connected. Authorize when prompted, then try again (Premium required for playback).",
        };
      }
      return fn(token);
    },
    [ensureAccessToken],
  );

  const handleSearchTracks = useCallback(
    async (params: Record<string, unknown>): Promise<ToolResult> => {
      const q = String(params.q ?? params.query ?? "").trim();
      const limit = Math.min(20, Math.max(1, Number(params.limit) || 10));
      if (!q) {
        return {
          success: false,
          error: "missing_q",
          displayText: "Provide a search query for tracks.",
        };
      }
      return withToken(async (token) => {
        const url = `/search?q=${encodeURIComponent(q)}&type=track&limit=${limit}`;
        const res = await spotifyFetch(url, token);
        if (!res.ok) {
          const err = await res.text();
          return {
            success: false,
            error: err,
            displayText: `Spotify search failed (${res.status}).`,
          };
        }
        const data = (await res.json()) as {
          tracks?: {
            items: Array<{
              name: string;
              artists: Array<{ name: string }>;
              uri: string;
              external_urls?: { spotify?: string };
            }>;
          };
        };
        const items = data.tracks?.items ?? [];
        const lines = items.map((t) => {
          const artists = t.artists.map((a) => a.name).join(", ");
          return `${t.name} — ${artists} (${t.uri})`;
        });
        const displayText =
          lines.length > 0
            ? `Found ${lines.length} tracks: ${lines.slice(0, 5).join("; ")}${lines.length > 5 ? "…" : ""}`
            : "No tracks found.";
        return {
          success: true,
          data: { tracks: items },
          displayText,
        };
      });
    },
    [withToken],
  );

  const handleCurrentlyPlaying = useCallback(async (): Promise<ToolResult> => {
    return withToken(async (token) => {
      const res = await spotifyFetch("/me/player/currently-playing", token);
      if (res.status === 204) {
        setNowPlaying(null);
        await notifyParent();
        return {
          success: true,
          data: { is_playing: false },
          displayText: "Nothing is currently playing on Spotify.",
        };
      }
      if (!res.ok) {
        return {
          success: false,
          error: await res.text(),
          displayText: "Could not read currently playing track.",
        };
      }
      const j = (await res.json()) as {
        is_playing?: boolean;
        item?: { name: string; artists?: Array<{ name: string }> };
      };
      const name = j.item?.name ?? "Unknown";
      const artists =
        j.item?.artists?.map((a) => a.name).join(", ") ?? "Unknown artist";
      const label = `${name} — ${artists}${j.is_playing ? " (playing)" : " (paused)"}`;
      setNowPlaying(label);
      await notifyParent();
      try {
        await parentRef.current?.signalCompletion(
          "track_loaded",
          `Now playing context: ${label}`,
        );
      } catch {
        /* ignore */
      }
      return {
        success: true,
        data: j,
        displayText: `Currently playing: ${label}.`,
      };
    });
  }, [withToken, notifyParent]);

  const handlePlaybackState = useCallback(async (): Promise<ToolResult> => {
    return withToken(async (token) => {
      const res = await spotifyFetch("/me/player", token);
      if (res.status === 204) {
        return {
          success: true,
          data: null,
          displayText: "No active Spotify device / nothing playing.",
        };
      }
      if (!res.ok) {
        return {
          success: false,
          error: await res.text(),
          displayText: "Could not read playback state.",
        };
      }
      const j = (await res.json()) as Record<string, unknown>;
      return {
        success: true,
        data: j,
        displayText: "Fetched Spotify playback state (see raw data in app).",
      };
    });
  }, [withToken]);

  const handleStartResume = useCallback(
    async (params: Record<string, unknown>): Promise<ToolResult> => {
      return withToken(async (token) => {
        const uri = params.uri as string | undefined;
        let uris = params.uris as string[] | undefined;
        if (typeof params.uris === "string") {
          try {
            const parsed = JSON.parse(params.uris) as unknown;
            if (Array.isArray(parsed)) uris = parsed as string[];
          } catch {
            uris = undefined;
          }
        }
        const body: Record<string, unknown> = {};
        if (uris && uris.length > 0) body.uris = uris;
        else if (uri) body.uris = [uri];
        const res = await spotifyFetch("/me/player/play", token, {
          method: "PUT",
          body: Object.keys(body).length ? JSON.stringify(body) : undefined,
        });
        if (res.status === 204 || res.ok) {
          try {
            await parentRef.current?.signalCompletion(
              "playback_started",
              "Playback started or resumed",
            );
          } catch {
            /* ignore */
          }
          return {
            success: true,
            data: { ok: true },
            displayText:
              "Playback command sent. If nothing plays, open Spotify on a device or transfer to the web player.",
          };
        }
        if (res.status === 404) {
          return {
            success: false,
            error: "no_device",
            displayText:
              "No active Spotify device. Start Spotify on phone/desktop or use transfer_to_web_player after the web player is ready.",
          };
        }
        const err = await res.text();
        return {
          success: false,
          error: err,
          displayText: `Could not start playback (${res.status}). Premium may be required.`,
        };
      });
    },
    [withToken],
  );

  const handleTransferWeb = useCallback(async (): Promise<ToolResult> => {
    return withToken(async (token) => {
      const dev = deviceIdRef.current;
      if (!dev) {
        return {
          success: false,
          error: "no_web_device",
          displayText:
            "Web Playback device is not ready yet. Wait a few seconds after the app loads, ensure Premium + streaming scope, then retry.",
        };
      }
      const res = await spotifyFetch("/me/player", token, {
        method: "PUT",
        body: JSON.stringify({
          device_ids: [dev],
          play: true,
        }),
      });
      if (res.status === 204 || res.ok) {
        setPlayerStatus(`Active device: web player (${dev.slice(0, 8)}…)`);
        return {
          success: true,
          data: { device_id: dev },
          displayText: "Playback transferred to the in-browser Spotify player.",
        };
      }
      const err = await res.text();
      return {
        success: false,
        error: err,
        displayText: "Transfer to web player failed.",
      };
    });
  }, [withToken]);

  const handleSearchTracksRef = useRef(handleSearchTracks);
  const handleCurrentlyPlayingRef = useRef(handleCurrentlyPlaying);
  const handlePlaybackStateRef = useRef(handlePlaybackState);
  const handleStartResumeRef = useRef(handleStartResume);
  const handleTransferWebRef = useRef(handleTransferWeb);
  const getStateSummaryRef = useRef(getStateSummary);
  handleSearchTracksRef.current = handleSearchTracks;
  handleCurrentlyPlayingRef.current = handleCurrentlyPlaying;
  handlePlaybackStateRef.current = handlePlaybackState;
  handleStartResumeRef.current = handleStartResume;
  handleTransferWebRef.current = handleTransferWeb;
  getStateSummaryRef.current = getStateSummary;

  useEffect(() => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      setSdkReady(true);
    };
    const existing = document.querySelector("script[data-spotify-sdk]");
    if (!existing) {
      const s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      s.async = true;
      s.dataset.spotifySdk = "1";
      document.body.appendChild(s);
    } else if (window.Spotify?.Player) {
      setSdkReady(true);
    }
    return () => {
      delete window.onSpotifyWebPlaybackSDKReady;
    };
  }, []);

  useEffect(() => {
    if (!sdkReady || connectionState !== "connected") return;
    const Spotify = window.Spotify;
    if (!Spotify?.Player) return;

    const parent = parentRef.current;
    if (!parent) return;

    const player = new Spotify.Player({
      name: "ChatBridge Web Player",
      getOAuthToken: (cb) => {
        void parent.getOAuthAccessToken("spotify", APP_ID).then((r) => {
          cb(r.accessToken ?? "");
        });
      },
      volume: 0.85,
    });

    player.addListener("ready", ({ device_id }) => {
      if (device_id) {
        deviceIdRef.current = device_id;
        setPlayerStatus(`Web player ready (device ${device_id.slice(0, 8)}…)`);
        void notifyParent();
      }
    });

    player.addListener("not_ready", () => {
      deviceIdRef.current = null;
      setPlayerStatus("Web player offline — reconnecting…");
    });

    player.addListener("initialization_error", ({ message }) => {
      setPlayerStatus(`Init error: ${message}`);
    });

    player.addListener("authentication_error", ({ message }) => {
      setPlayerStatus(`Auth error: ${message}`);
    });

    player.addListener("account_error", ({ message }) => {
      setPlayerStatus(`Account error: ${message} (Premium required for Web Playback)`);
    });

    player.addListener("playback_error", ({ message }) => {
      setPlayerStatus(`Playback error: ${message}`);
    });

    player.addListener("player_state_changed", (state: unknown) => {
      const s = state as {
        paused: boolean;
        track_window?: { current_track?: { name?: string } };
      } | null;
      if (s?.track_window?.current_track?.name) {
        const n = s.track_window.current_track.name;
        setNowPlaying(`${n}${s.paused ? " (paused)" : ""}`);
        void notifyParent();
      }
    });

    playerRef.current = player;
    void player.connect().then((ok) => {
      if (!ok) setPlayerStatus("Could not connect Web Playback SDK.");
    });

    return () => {
      player.disconnect();
      playerRef.current = null;
      deviceIdRef.current = null;
    };
  }, [sdkReady, connectionState, notifyParent]);

  useEffect(() => {
    const messenger = new WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ["*"],
    });

    const connection = connect<PlatformMethods>({
      messenger,
      methods: {
        async initialize(_config: AppInitConfig) {
          /* session metadata only */
        },
        async invokeTool(
          toolName: string,
          params: Record<string, unknown>,
        ): Promise<ToolResult> {
          switch (toolName) {
            case "search_tracks":
              return handleSearchTracksRef.current(params);
            case "get_currently_playing":
              return handleCurrentlyPlayingRef.current();
            case "get_playback_state":
              return handlePlaybackStateRef.current();
            case "start_resume_playback":
              return handleStartResumeRef.current(params);
            case "transfer_to_web_player":
              return handleTransferWebRef.current();
            default:
              return {
                success: false,
                error: `Unknown tool: ${toolName}`,
                displayText: `Unknown tool "${toolName}".`,
              };
          }
        },
        async getState(): Promise<AppStateSummary> {
          return getStateSummaryRef.current();
        },
        async destroy() {
          playerRef.current?.disconnect();
        },
      },
      timeout: 5000,
    });

    connection.promise
      .then(async (parent) => {
        parentRef.current = parent;
        setConnectionState("connected");
        await parent.notifyStateUpdate(getStateSummaryRef.current());
        try {
          await parent.requestResize(480);
        } catch {
          /* ignore */
        }
      })
      .catch((err) => {
        console.error("[Spotify] Penpal failed:", err);
        setConnectionState("error");
      });

    return () => connection.destroy();
  }, []);

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-gray-900 p-4 text-gray-100">
      <div>
        <h1 className="text-center text-base font-semibold text-white">
          Spotify
        </h1>
        <p className="text-center text-xs text-gray-400">{playerStatus}</p>
        {connectionState === "connecting" && (
          <p className="text-center text-xs text-gray-500">Connecting…</p>
        )}
        {connectionState === "error" && (
          <p className="text-center text-xs text-red-400">
            Failed to connect to platform.
          </p>
        )}
      </div>

      {nowPlaying && (
        <div className="rounded-lg border border-green-900/50 bg-green-950/30 px-3 py-2 text-center text-sm text-green-100">
          {nowPlaying}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-gray-500">
        Web Playback SDK requires Spotify Premium (not mobile-only plans). See
        developer.spotify.com for API terms.
      </p>
    </div>
  );
}
