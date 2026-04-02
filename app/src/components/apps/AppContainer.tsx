import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { connect, WindowMessenger } from "penpal";
import type { Connection } from "penpal";
import type {
  AppManifest,
  AppMethods,
  AppStateSummary,
  ToolResult,
} from "../../types";

export interface AppContainerHandle {
  invokeTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
  destroy(): Promise<void>;
}

interface AppContainerProps {
  manifest: AppManifest;
  sessionId: string;
  onClose: () => void;
  onStateUpdate: (state: AppStateSummary) => void;
  onCompletion: (event: string, summary: string) => void;
}

type ConnectionState = "loading" | "connected" | "error";

const AppContainer = forwardRef<AppContainerHandle, AppContainerProps>(
  function AppContainer(
    { manifest, sessionId, onClose, onStateUpdate, onCompletion },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const connectionRef = useRef<Connection<AppMethods> | null>(null);
    const appMethodsRef = useRef<Awaited<
      Connection<AppMethods>["promise"]
    > | null>(null);
    const [state, setState] = useState<ConnectionState>("loading");
    const [errorMsg, setErrorMsg] = useState("");
    const [iframeHeight, setIframeHeight] = useState(manifest.iframe.height);

    const setupConnection = useCallback(() => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      setState("loading");
      setErrorMsg("");

      const messenger = new WindowMessenger({
        remoteWindow: iframe.contentWindow,
        allowedOrigins: ["*"],
      });

      const conn = connect<AppMethods>({
        messenger,
        methods: {
          notifyStateUpdate: async (s: AppStateSummary) => {
            onStateUpdate(s);
          },
          signalCompletion: async (event: string, summary: string) => {
            onCompletion(event, summary);
          },
          requestResize: async (height: number) => {
            setIframeHeight(`${height}px`);
          },
          requestAuth: async () => {
            return { success: false, error: "OAuth not yet implemented" };
          },
        },
        timeout: 5000,
      });

      connectionRef.current = conn;

      conn.promise
        .then(async (methods) => {
          appMethodsRef.current = methods;
          setState("connected");
          await methods.initialize({
            sessionId,
            theme: "dark",
            locale: "en",
          });
        })
        .catch((err) => {
          console.error("Penpal connection failed:", err);
          setState("error");
          setErrorMsg(
            err instanceof Error ? err.message : "Connection failed",
          );
        });
    }, [manifest, sessionId, onStateUpdate, onCompletion]);

    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      const handleLoad = () => setupConnection();
      iframe.addEventListener("load", handleLoad);

      return () => {
        iframe.removeEventListener("load", handleLoad);
        connectionRef.current?.destroy();
        connectionRef.current = null;
        appMethodsRef.current = null;
      };
    }, [setupConnection]);

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
      }),
      [],
    );

    return (
      <div className="flex h-full flex-col bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
          <span className="text-sm font-medium text-gray-200">
            {manifest.name}
          </span>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
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

        <div className="relative flex-1 overflow-hidden">
          {state === "loading" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80">
              <div className="flex flex-col items-center gap-2">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
                <span className="text-xs text-gray-400">
                  Loading {manifest.name}...
                </span>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80">
              <div className="flex flex-col items-center gap-3 px-4 text-center">
                <span className="text-sm text-red-400">
                  {errorMsg || "Failed to connect to app"}
                </span>
                <button
                  onClick={setupConnection}
                  className="rounded bg-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-600"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          <iframe
            ref={iframeRef}
            src={manifest.entry_url}
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="clipboard-write"
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
