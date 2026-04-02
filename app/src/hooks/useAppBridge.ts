import { useEffect, useRef, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { pendingToolCallAtom } from "../stores/chat";
import { activeConversationIdAtom } from "../stores/conversations";
import {
  activeAppAtom,
  activeAppSessionsAtom,
  appContainerReadyAtom,
} from "../stores/apps";
import { useChat } from "./useChat";
import { apiFetch } from "../lib/api";
import type { AppManifest, ToolResult, AppSession } from "../types";
import type { AppContainerHandle } from "../components/apps/AppContainer";

interface PendingInvocation {
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
}

export function useAppBridge() {
  const pendingToolCall = useAtomValue(pendingToolCallAtom);
  const setPendingToolCall = useSetAtom(pendingToolCallAtom);
  const conversationId = useAtomValue(activeConversationIdAtom);
  const setActiveApp = useSetAtom(activeAppAtom);
  const setActiveAppSessions = useSetAtom(activeAppSessionsAtom);
  const containerReady = useAtomValue(appContainerReadyAtom);
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

  const executeInvocation = useCallback(
    async (invocation: PendingInvocation) => {
      const handle = containerRef.current;
      if (!handle) {
        await submitToolResult(invocation.callId, {
          success: false,
          error: "App container not ready",
          displayText: "The app failed to load. Please try again.",
        });
        return;
      }

      const timeoutMs = 10_000;
      let result: ToolResult;
      try {
        result = await Promise.race([
          handle.invokeTool(invocation.toolName, invocation.params),
          new Promise<ToolResult>((_, reject) =>
            setTimeout(
              () => reject(new Error("Tool call timed out after 10s")),
              timeoutMs,
            ),
          ),
        ]);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Tool invocation failed";
        result = { success: false, error: msg, displayText: msg };
      }

      await submitToolResult(invocation.callId, result);
    },
    [submitToolResult],
  );

  // When the container becomes ready and there's a pending invocation, execute it
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

  // Process incoming tool_invoke events
  useEffect(() => {
    if (!pendingToolCall || processingRef.current) return;

    const event = pendingToolCall;
    setPendingToolCall(null);

    if (event.tool === "list_available_apps") return;

    const invocation: PendingInvocation = {
      callId: event.callId,
      toolName: event.tool,
      params: (event.params as Record<string, unknown>) ?? {},
    };

    (async () => {
      try {
        const manifest = await fetchManifest(event.appId);

        const session = await createAppSession(event.appId);
        if (!session) {
          await submitToolResult(invocation.callId, {
            success: false,
            error: "No active conversation",
            displayText: "No active conversation to create app session.",
          });
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
      }
    })();
  }, [
    pendingToolCall,
    setPendingToolCall,
    fetchManifest,
    createAppSession,
    setActiveApp,
    executeInvocation,
    submitToolResult,
  ]);

  const closeApp = useCallback(async () => {
    try {
      await containerRef.current?.destroy();
    } catch {
      /* best effort */
    }
    containerRef.current = null;
    pendingInvocationRef.current = null;
    setActiveApp(null);
  }, [setActiveApp]);

  return { setContainerRef, closeApp };
}
