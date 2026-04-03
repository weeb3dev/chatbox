import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { connect, WindowMessenger, PenpalError, ErrorCode } from "penpal";
import type { Connection } from "penpal";
import type {
  AppManifest,
  AppMethods,
  AppStateSummary,
  ToolResult,
  AuthResult,
  OAuthAccessTokenResult,
} from "../../types";
import { getAuthToken } from "../../lib/api";

export interface AppContainerHandle {
  invokeTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
  destroy(): Promise<void>;
  reportTransportFailure(reason?: string): void;
}

interface AppContainerProps {
  manifest: AppManifest;
  sessionId: string;
  onClose: () => void;
  /** Collapse the app panel to a chip; iframe stays mounted for tools. */
  onMinimize?: () => void;
  onStateUpdate: (state: AppStateSummary) => void;
  onCompletion: (event: string, summary: string) => void;
  onReady?: () => void;
  /** Circuit breaker: show instability warning */
  degradedWarning?: boolean;
}

type ConnectionState = "loading" | "connected" | "error" | "disconnected";

const IFRAME_LOAD_MS = 5000;

const AppContainer = forwardRef<AppContainerHandle, AppContainerProps>(
  function AppContainer(
    {
      manifest,
      sessionId,
      onClose,
      onMinimize,
      onStateUpdate,
      onCompletion,
      onReady,
      degradedWarning,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const connectionRef = useRef<Connection<AppMethods> | null>(null);
    const appMethodsRef = useRef<Awaited<
      Connection<AppMethods>["promise"]
    > | null>(null);
    const [state, setState] = useState<ConnectionState>("loading");
    const [errorMsg, setErrorMsg] = useState("");
    const [disconnectReason, setDisconnectReason] = useState("");
    const [iframeHeight, setIframeHeight] = useState(manifest.iframe.height);
    const [reloadKey, setReloadKey] = useState(0);

    const lastErrorKindRef = useRef<"load" | "penpal">("penpal");
    const lastStateSummaryRef = useRef<AppStateSummary | null>(null);
    const lastInitializedSessionRef = useRef<string | null>(null);

    const onStateUpdateRef = useRef(onStateUpdate);
    const onCompletionRef = useRef(onCompletion);
    const onReadyRef = useRef(onReady);

    useLayoutEffect(() => {
      onStateUpdateRef.current = onStateUpdate;
      onCompletionRef.current = onCompletion;
      onReadyRef.current = onReady;
    }, [onStateUpdate, onCompletion, onReady]);

    const [lastStateDisplay, setLastStateDisplay] = useState<string | null>(
      null,
    );

    const destroyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const setupConnection = useCallback(() => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      if (connectionRef.current) {
        connectionRef.current.destroy();
        connectionRef.current = null;
        appMethodsRef.current = null;
      }

      setState("loading");
      setErrorMsg("");
      setDisconnectReason("");

      const messenger = new WindowMessenger({
        remoteWindow: iframe.contentWindow,
        allowedOrigins: ["*"],
      });

      const conn = connect<AppMethods>({
        messenger,
        methods: {
          notifyStateUpdate: async (s: AppStateSummary) => {
            lastStateSummaryRef.current = s;
            setLastStateDisplay(s.display ?? null);
            onStateUpdateRef.current(s);
          },
          signalCompletion: async (event: string, summary: string) => {
            onCompletionRef.current(event, summary);
          },
          requestResize: async (height: number) => {
            setIframeHeight(`${height}px`);
          },
          requestAuth: async (
            provider: string,
            scopes: string[],
          ): Promise<AuthResult> => {
            if (provider !== "spotify") {
              return {
                success: false,
                error: `Unsupported OAuth provider: ${provider}`,
              };
            }
            const jwt = getAuthToken();
            if (!jwt) {
              return { success: false, error: "Not logged in to ChatBridge" };
            }
            const origin = window.location.origin;
            const appId = manifest.id;
            const q = new URLSearchParams({
              app_id: appId,
              bridge_jwt: jwt,
            });
            if (scopes.length > 0) {
              q.set("scope", scopes.join(" "));
            }
            const url = `${origin}/api/oauth/spotify/authorize?${q.toString()}`;

            return new Promise((resolve) => {
              let done = false;
              const w = window.open(
                url,
                "chatbridge_oauth",
                "width=520,height=720",
              );

              const onMessage = (e: MessageEvent) => {
                if (e.origin !== origin) return;
                const d = e.data as Record<string, unknown> | null;
                if (!d || d.type !== "chatbridge-oauth") return;
                if (d.provider !== "spotify" || d.appId !== appId) return;
                if (d.success) {
                  finish({ success: true });
                } else {
                  finish({
                    success: false,
                    error: String(d.error ?? "OAuth failed"),
                  });
                }
              };

              const finish = (r: AuthResult) => {
                if (done) return;
                done = true;
                clearInterval(tick);
                window.removeEventListener("message", onMessage);
                resolve(r);
              };

              window.addEventListener("message", onMessage);

              const tick = window.setInterval(() => {
                if (done) return;
                if (w?.closed) {
                  finish({ success: false, error: "OAuth window closed" });
                }
              }, 400);
            });
          },
          getOAuthAccessToken: async (
            provider: string,
            appId: string,
          ): Promise<OAuthAccessTokenResult> => {
            if (provider !== "spotify" || appId !== manifest.id) {
              return {
                success: false,
                error: "Unsupported OAuth target for this app",
              };
            }
            const jwt = getAuthToken();
            if (!jwt) {
              return { success: false, error: "Not logged in to ChatBridge" };
            }
            const origin = window.location.origin;
            const res = await fetch(
              `${origin}/api/oauth/spotify/token?app_id=${encodeURIComponent(appId)}`,
              { headers: { Authorization: `Bearer ${jwt}` } },
            );
            if (res.status === 404) {
              const body = (await res.json().catch(() => ({}))) as {
                error?: string;
              };
              return {
                success: false,
                error: body.error ?? "not_linked",
              };
            }
            if (!res.ok) {
              return {
                success: false,
                error: `Token request failed (${res.status})`,
              };
            }
            const body = (await res.json()) as {
              success?: boolean;
              accessToken?: string;
              expiresAt?: number;
            };
            if (!body.success || !body.accessToken) {
              return { success: false, error: "No access token in response" };
            }
            return {
              success: true,
              accessToken: body.accessToken,
              expiresAt: body.expiresAt,
            };
          },
        },
        timeout: 5000,
      });

      connectionRef.current = conn;

      conn.promise
        .then(async (methods) => {
          appMethodsRef.current = methods;
          setState("connected");
          onReadyRef.current?.();
          lastInitializedSessionRef.current = sessionId;
          await methods.initialize({
            sessionId,
            theme: "dark",
            locale: "en",
          });
        })
        .catch((err) => {
          console.error("Penpal connection failed:", err);
          lastErrorKindRef.current = "penpal";
          setState("error");
          setErrorMsg(
            err instanceof Error ? err.message : "Connection failed",
          );
        });
    }, [manifest, sessionId]);

    const setupConnectionRef = useRef(setupConnection);
    useLayoutEffect(() => {
      setupConnectionRef.current = setupConnection;
    }, [setupConnection]);

    useLayoutEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      let cancelled = false;
      const loadTimer = window.setTimeout(() => {
        if (cancelled) return;
        console.error("[ChatBridge] App iframe load timeout", {
          appId: manifest.id,
          entry_url: manifest.entry_url,
        });
        lastErrorKindRef.current = "load";
        setState("error");
        setErrorMsg("App failed to load");
      }, IFRAME_LOAD_MS);

      const handleLoad = () => {
        if (cancelled) return;
        window.clearTimeout(loadTimer);
        setupConnectionRef.current();
      };

      iframe.addEventListener("load", handleLoad);

      return () => {
        cancelled = true;
        window.clearTimeout(loadTimer);
        iframe.removeEventListener("load", handleLoad);
      };
    }, [manifest.entry_url, manifest.id, reloadKey]);

    useEffect(() => {
      if (state !== "connected") return;
      const methods = appMethodsRef.current;
      if (!methods) return;
      if (lastInitializedSessionRef.current === sessionId) return;
      lastInitializedSessionRef.current = sessionId;
      void methods.initialize({
        sessionId,
        theme: "dark",
        locale: "en",
      });
    }, [sessionId, state]);

    useEffect(() => {
      if (destroyTimerRef.current) {
        clearTimeout(destroyTimerRef.current);
        destroyTimerRef.current = null;
      }

      return () => {
        destroyTimerRef.current = setTimeout(() => {
          connectionRef.current?.destroy();
          connectionRef.current = null;
          appMethodsRef.current = null;
        }, 100);
      };
    }, [setupConnection]);

    const restartIframe = useCallback(() => {
      if (connectionRef.current) {
        connectionRef.current.destroy();
        connectionRef.current = null;
        appMethodsRef.current = null;
      }
      lastInitializedSessionRef.current = null;
      setReloadKey((k) => k + 1);
      setState("loading");
      setErrorMsg("");
      setDisconnectReason("");
    }, []);

    const handleRetry = useCallback(() => {
      if (state === "disconnected" || lastErrorKindRef.current === "load") {
        restartIframe();
        return;
      }
      setupConnection();
    }, [state, restartIframe, setupConnection]);

    useImperativeHandle(
      ref,
      () => ({
        async invokeTool(
          toolName: string,
          params: Record<string, unknown>,
        ): Promise<ToolResult> {
          const methods = appMethodsRef.current;
          if (!methods) {
            return {
              success: false,
              error: "App not connected",
              displayText: "The app is not connected. Please try again.",
            };
          }
          try {
            return await methods.invokeTool(toolName, params);
          } catch (err) {
            const isDestroyed =
              err instanceof PenpalError &&
              err.code === ErrorCode.ConnectionDestroyed;
            if (isDestroyed) {
              setState("disconnected");
              setDisconnectReason("The connection to the app was lost.");
            }
            const msg =
              err instanceof Error ? err.message : "Tool invocation failed";
            return { success: false, error: msg, displayText: msg };
          }
        },
        async destroy() {
          try {
            await appMethodsRef.current?.destroy();
          } catch {
            /* best effort */
          }
          connectionRef.current?.destroy();
          connectionRef.current = null;
          appMethodsRef.current = null;
        },
        reportTransportFailure(reason?: string) {
          setState("disconnected");
          setDisconnectReason(
            reason ?? "The connection to the app was interrupted.",
          );
        },
      }),
      [],
    );

    return (
      <div className="flex h-full flex-col bg-surface shadow-[0_0_24px_rgba(0,0,0,0.35)] ring-1 ring-border/80">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium text-gray-200">
            {manifest.name}
          </span>
          <div className="flex items-center gap-0.5">
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className="rounded p-1 text-gray-400 hover:bg-surface-hover hover:text-gray-200"
                title="Minimize"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20 12H4"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-gray-400 hover:bg-surface-hover hover:text-gray-200"
              title="Close"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {degradedWarning && state === "connected" && (
          <div className="border-b border-amber-900/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-200/90">
            This app has been unstable recently. If something fails, try
            restarting it or switching tasks.
          </div>
        )}

        <div className="relative flex-1 overflow-hidden">
          {state === "loading" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/90">
              <div className="flex flex-col items-center gap-2">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
                <span className="text-xs text-gray-400">
                  Loading {manifest.name}...
                </span>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/90">
              <div className="flex flex-col items-center gap-3 px-4 text-center">
                <span className="text-sm font-medium text-red-300">
                  {errorMsg === "App failed to load"
                    ? "App failed to load"
                    : null}
                </span>
                {errorMsg && errorMsg !== "App failed to load" && (
                  <span className="text-sm text-red-400">{errorMsg}</span>
                )}
                {!errorMsg && (
                  <span className="text-sm text-red-400">
                    Failed to connect to app
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleRetry}
                  className="rounded bg-surface-hover px-3 py-1.5 text-xs text-gray-200 hover:bg-border"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {state === "disconnected" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/90">
              <div className="flex max-w-xs flex-col items-center gap-3 px-4 text-center">
                <span className="text-sm font-medium text-amber-200">
                  App disconnected
                </span>
                <span className="text-xs text-gray-400">
                  {disconnectReason}
                </span>
                {lastStateDisplay && (
                  <span className="text-xs text-gray-500">
                    Last state: {lastStateDisplay}
                  </span>
                )}
                <button
                  type="button"
                  onClick={restartIframe}
                  className="rounded bg-surface-hover px-3 py-1.5 text-xs text-gray-200 hover:bg-border"
                >
                  Restart
                </button>
              </div>
            </div>
          )}

          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={manifest.entry_url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="clipboard-write; encrypted-media; autoplay"
            referrerPolicy="no-referrer"
            style={{
              width: manifest.iframe.width,
              height: iframeHeight,
              border: "none",
            }}
            className="w-full"
          />
        </div>
      </div>
    );
  },
);

export default AppContainer;
