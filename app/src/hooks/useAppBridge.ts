import { useEffect, useRef, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  pendingToolCallAtom,
  toolInvocationBusyAtom,
} from "../stores/chat";
import { activeConversationIdAtom } from "../stores/conversations";
import {
  activeAppAtom,
  activeAppSessionsAtom,
  appContainerReadyAtom,
  appCircuitTickAtom,
} from "../stores/apps";
import { useChat } from "./useChat";
import { apiFetch } from "../lib/api";
import {
  isAppDisabled,
  recordAppFailure,
  recordAppSuccess,
} from "../lib/appCircuitBreaker";
import type { AppManifest, ToolResult, AppSession } from "../types";
import type { AppContainerHandle } from "../components/apps/AppContainer";

interface PendingInvocation {
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  appId: string;
  appName: string;
}

const TOOL_TIMEOUT_MS = 10_000;

export function useAppBridge() {
  const pendingToolCall = useAtomValue(pendingToolCallAtom);
  const setPendingToolCall = useSetAtom(pendingToolCallAtom);
  const setToolInvocationBusy = useSetAtom(toolInvocationBusyAtom);
  const conversationId = useAtomValue(activeConversationIdAtom);
  const setActiveApp = useSetAtom(activeAppAtom);
  const setActiveAppSessions = useSetAtom(activeAppSessionsAtom);
  const containerReady = useAtomValue(appContainerReadyAtom);
  const setContainerReady = useSetAtom(appContainerReadyAtom);
  const bumpCircuitTick = useSetAtom(appCircuitTickAtom);
  const { submitToolResult } = useChat();

  const containerRef = useRef<AppContainerHandle | null>(null);
  const pendingInvocationRef = useRef<PendingInvocation | null>(null);
  const processingRef = useRef(false);

  const setContainerRef = useCallback(
    (handle: AppContainerHandle | null) => {
      containerRef.current = handle;
    },
    [],
  );

  const fetchManifest = useCallback(async (appId: string) => {
    return apiFetch<AppManifest>(`/api/apps/${appId}/manifest`);
  }, []);

  const createAppSession = useCallback(
    async (appId: string) => {
      if (!conversationId) return null;
      const session = await apiFetch<AppSession>("/api/app-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, appId }),
      });
      setActiveAppSessions((prev) => [...prev, session]);
      return session;
    },
    [conversationId, setActiveAppSessions],
  );

  const teardownContainer = useCallback(async () => {
    try {
      await containerRef.current?.destroy();
    } catch {
      /* best effort */
    }
    containerRef.current = null;
    pendingInvocationRef.current = null;
    setActiveApp(null);
    setContainerReady(false);
    setToolInvocationBusy(null);
  }, [setActiveApp, setContainerReady, setToolInvocationBusy]);

  const executeInvocation = useCallback(
    async (invocation: PendingInvocation) => {
      try {
        if (isAppDisabled(invocation.appId)) {
          await submitToolResult(invocation.callId, {
            success: false,
            error: "app_circuit_open",
            displayText:
              "This app has had too many failures in a short time and was paused for this session. You can try again in a new chat, or ask me to help without that app.",
          });
          await teardownContainer();
          bumpCircuitTick((t) => t + 1);
          return;
        }

        const handle = containerRef.current;
        if (!handle) {
          await submitToolResult(invocation.callId, {
            success: false,
            error: "App container not ready",
            displayText: "The app failed to load. Please try again.",
          });
          return;
        }

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let result: ToolResult;
        try {
          result = await Promise.race([
            handle.invokeTool(invocation.toolName, invocation.params),
            new Promise<ToolResult>((_, reject) => {
              timeoutId = window.setTimeout(
                () => reject(new Error("__TOOL_TIMEOUT__")),
                TOOL_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (err) {
          if (err instanceof Error && err.message === "__TOOL_TIMEOUT__") {
            result = {
              success: false,
              error: "App did not respond in time",
              displayText: `${invocation.appName} took too long to respond. It may have encountered an error.`,
            };
          } else {
            const msg =
              err instanceof Error ? err.message : "Tool invocation failed";
            result = { success: false, error: msg, displayText: msg };
          }
        } finally {
          if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        }

        if (result.success) {
          recordAppSuccess(invocation.appId);
        } else {
          recordAppFailure(invocation.appId);
        }
        bumpCircuitTick((t) => t + 1);

        await submitToolResult(invocation.callId, result);
      } finally {
        setToolInvocationBusy(null);
      }
    },
    [
      submitToolResult,
      teardownContainer,
      bumpCircuitTick,
      setToolInvocationBusy,
    ],
  );

  useEffect(() => {
    if (containerReady && pendingInvocationRef.current && !processingRef.current) {
      processingRef.current = true;
      const invocation = pendingInvocationRef.current;
      pendingInvocationRef.current = null;
      executeInvocation(invocation).finally(() => {
        processingRef.current = false;
      });
    }
  }, [containerReady, executeInvocation]);

  useEffect(() => {
    if (!pendingToolCall || processingRef.current) return;

    const event = pendingToolCall;
    setPendingToolCall(null);

    if (event.tool === "list_available_apps") return;

    const invocation: PendingInvocation = {
      callId: event.callId,
      toolName: event.tool,
      params: (event.params as Record<string, unknown>) ?? {},
      appId: event.appId,
      appName: event.appId,
    };

    setToolInvocationBusy({
      tool: event.tool,
      displayLabel: event.appId,
    });

    (async () => {
      try {
        if (isAppDisabled(event.appId)) {
          await submitToolResult(invocation.callId, {
            success: false,
            error: "app_circuit_open",
            displayText:
              "This app has had too many failures in a short time and was paused for this session. You can try again in a new chat, or ask me to help without that app.",
          });
          bumpCircuitTick((t) => t + 1);
          setToolInvocationBusy(null);
          return;
        }

        const manifest = await fetchManifest(event.appId);
        invocation.appName = manifest.name;
        setToolInvocationBusy({
          tool: event.tool,
          displayLabel: manifest.name,
        });

        const session = await createAppSession(event.appId);
        if (!session) {
          await submitToolResult(invocation.callId, {
            success: false,
            error: "No active conversation",
            displayText: "No active conversation to create app session.",
          });
          setToolInvocationBusy(null);
          return;
        }

        setActiveApp({ manifest, sessionId: session.id, appId: event.appId });

        if (containerRef.current) {
          await executeInvocation(invocation);
        } else {
          pendingInvocationRef.current = invocation;
        }
      } catch (err) {
        console.error("useAppBridge: failed to open app", err);
        await submitToolResult(invocation.callId, {
          success: false,
          error: "Failed to load app",
          displayText: "The app could not be loaded. Please try again.",
        });
        recordAppFailure(event.appId);
        bumpCircuitTick((t) => t + 1);
        setToolInvocationBusy(null);
      }
    })();
  }, [
    pendingToolCall,
    setPendingToolCall,
    setToolInvocationBusy,
    fetchManifest,
    createAppSession,
    setActiveApp,
    executeInvocation,
    submitToolResult,
    bumpCircuitTick,
  ]);

  const closeApp = useCallback(async () => {
    await teardownContainer();
  }, [teardownContainer]);

  return { setContainerRef, closeApp };
}
