import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeConversationIdAtom } from "../stores/conversations";
import {
  messagesAtom,
  isStreamingAtom,
  streamingMessageAtom,
  pendingToolCallAtom,
  toolInvocationBusyAtom,
  streamErrorAtom,
} from "../stores/chat";
import { apiStream, apiFetch, getAuthToken } from "../lib/api";
import type { Message, ServerMessage, ToolResult } from "../types";

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000];
const MAX_RECONNECTS = 3;

function buildChatWebSocketUrl(conversationId: string, token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${proto}//${host}/ws/chat/${encodeURIComponent(conversationId)}?token=${encodeURIComponent(token)}`;
}

async function consumeSSEStream(
  response: Response,
  onChunk: (text: string) => void,
  onToolInvoke: (event: ServerMessage & { type: "tool_invoke" }) => void,
  onDone: (messageId: string) => void,
  onError: (message: string) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    onError("No response stream");
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;

        let event: ServerMessage;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case "assistant_chunk":
            onChunk(event.content);
            break;
          case "tool_invoke":
            onToolInvoke(event as ServerMessage & { type: "tool_invoke" });
            break;
          case "assistant_done":
            onDone(event.messageId);
            break;
          case "error":
            onError(event.message);
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function useChat() {
  const conversationId = useAtomValue(activeConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  const setIsStreaming = useSetAtom(isStreamingAtom);
  const setStreamingMessage = useSetAtom(streamingMessageAtom);
  const setPendingToolCall = useSetAtom(pendingToolCallAtom);
  const setToolInvocationBusy = useSetAtom(toolInvocationBusyAtom);
  const setStreamError = useSetAtom(streamErrorAtom);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const conversationIdRef = useRef<string | null>(null);
  /** Streaming accumulator for the active turn (WS or SSE). */
  const accumulatedTextRef = useRef("");
  const wsBoundConversationIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const handleServerEvent = useCallback(
    (
      event: ServerMessage,
      convId: string,
      accumulatedText: { current: string },
      onDoneExtras?: () => void,
    ) => {
      switch (event.type) {
        case "assistant_chunk":
          accumulatedText.current += event.content;
          setStreamingMessage(accumulatedText.current);
          break;
        case "tool_invoke":
          setPendingToolCall(
            event as ServerMessage & { type: "tool_invoke" },
          );
          break;
        case "assistant_done": {
          if (accumulatedText.current) {
            const assistantMsg: Message = {
              id: event.messageId,
              conversationId: convId,
              role: "assistant",
              content: accumulatedText.current,
              toolName: null,
              toolParams: null,
              toolResult: null,
              appId: null,
              sequenceNum: Date.now(),
              createdAt: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, assistantMsg]);
          }
          accumulatedText.current = "";
          setStreamingMessage("");
          setIsStreaming(false);
          setToolInvocationBusy(null);
          onDoneExtras?.();
          break;
        }
        case "error":
          console.error("Chat stream error:", event.message);
          setStreamError(
            event.message || "Something went wrong. Try again.",
          );
          accumulatedText.current = "";
          setStreamingMessage("");
          setIsStreaming(false);
          setToolInvocationBusy(null);
          onDoneExtras?.();
          break;
        default:
          break;
      }
    },
    [
      setMessages,
      setStreamingMessage,
      setPendingToolCall,
      setIsStreaming,
      setStreamError,
      setToolInvocationBusy,
    ],
  );

  const handleServerEventRef = useRef(handleServerEvent);
  useLayoutEffect(() => {
    handleServerEventRef.current = handleServerEvent;
  }, [handleServerEvent]);

  const refetchRef = useRef(async (id: string) => {
    try {
      const data = await apiFetch<{ messages: Message[] }>(
        `/api/conversations/${id}`,
      );
      setMessages(data.messages ?? []);
    } catch {
      /* keep current */
    }
  });
  useLayoutEffect(() => {
    refetchRef.current = async (id: string) => {
      try {
        const data = await apiFetch<{ messages: Message[] }>(
          `/api/conversations/${id}`,
        );
        setMessages(data.messages ?? []);
      } catch {
        /* keep current */
      }
    };
  }, [setMessages]);

  // WS lifecycle: only re-run when conversationId changes (refs keep handlers stable)
  useEffect(() => {
    reconnectAttemptRef.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const prev = wsRef.current;
    if (prev) {
      prev.close(1000, "conversation change");
      wsRef.current = null;
    }

    if (!conversationId) {
      wsBoundConversationIdRef.current = null;
      return;
    }

    const token = getAuthToken();
    if (!token) {
      wsBoundConversationIdRef.current = null;
      return;
    }

    const boundId = conversationId;
    wsBoundConversationIdRef.current = boundId;

    const connect = () => {
      if (conversationIdRef.current !== boundId) return;

      const url = buildChatWebSocketUrl(boundId, token);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (conversationIdRef.current !== boundId) return;
        let event: ServerMessage;
        try {
          event = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        handleServerEventRef.current(event, boundId, accumulatedTextRef);
      };

      ws.onopen = () => {
        if (conversationIdRef.current !== boundId) return;
        reconnectAttemptRef.current = 0;
      };

      const scheduleReconnect = () => {
        if (conversationIdRef.current !== boundId) return;
        if (reconnectAttemptRef.current >= MAX_RECONNECTS) return;
        const delay =
          RECONNECT_BACKOFF_MS[reconnectAttemptRef.current] ??
          RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
        reconnectAttemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          void refetchRef.current(boundId).finally(() => {
            connect();
          });
        }, delay);
      };

      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (conversationIdRef.current !== boundId) return;
        if (ev.code === 1000) return;
        scheduleReconnect();
      };

      ws.onerror = () => {
        /* onclose will run; prefer SSE until reconnect */
      };
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const w = wsRef.current;
      if (w) {
        w.close(1000, "unmount");
        wsRef.current = null;
      }
      wsBoundConversationIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const runViaSSE = useCallback(
    async (
      sseCall: () => Promise<Response>,
      convId: string,
    ): Promise<void> => {
      let accumulatedText = "";
      accumulatedTextRef.current = "";
      try {
        const response = await sseCall();
        await consumeSSEStream(
          response,
          (chunk) => {
            accumulatedText += chunk;
            accumulatedTextRef.current = accumulatedText;
            setStreamingMessage(accumulatedText);
          },
          (toolEvent) => {
            setPendingToolCall(toolEvent);
          },
          (messageId) => {
            if (accumulatedText) {
              const assistantMsg: Message = {
                id: messageId,
                conversationId: convId,
                role: "assistant",
                content: accumulatedText,
                toolName: null,
                toolParams: null,
                toolResult: null,
                appId: null,
                sequenceNum: Date.now(),
                createdAt: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, assistantMsg]);
            }
            accumulatedTextRef.current = "";
            setStreamingMessage("");
            setIsStreaming(false);
            setToolInvocationBusy(null);
          },
          (errorMsg) => {
            console.error("Chat stream error:", errorMsg);
            setStreamError(
              errorMsg || "Something went wrong. Try again.",
            );
            accumulatedTextRef.current = "";
            setStreamingMessage("");
            setIsStreaming(false);
            setToolInvocationBusy(null);
          },
        );
      } catch (err) {
        console.error("Chat request failed:", err);
        setStreamError("Something went wrong. Try again.");
        accumulatedTextRef.current = "";
        setStreamingMessage("");
        setIsStreaming(false);
        setToolInvocationBusy(null);
      }
    },
    [
      setMessages,
      setStreamingMessage,
      setPendingToolCall,
      setIsStreaming,
      setStreamError,
      setToolInvocationBusy,
    ],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!conversationId) return;

      setStreamError(null);

      const tempUserMsg: Message = {
        id: `temp-${Date.now()}`,
        conversationId,
        role: "user",
        content,
        toolName: null,
        toolParams: null,
        toolResult: null,
        appId: null,
        sequenceNum: Date.now(),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempUserMsg]);
      setIsStreaming(true);
      setStreamingMessage("");
      accumulatedTextRef.current = "";

      const ws = wsRef.current;
      const useWs =
        ws &&
        ws.readyState === WebSocket.OPEN &&
        wsBoundConversationIdRef.current === conversationId;

      if (useWs) {
        try {
          ws.send(JSON.stringify({ type: "user_message", content }));
        } catch (err) {
          console.error("WebSocket send failed, falling back to SSE:", err);
          await runViaSSE(
            () => apiStream("/api/chat", { conversationId, content }),
            conversationId,
          );
        }
        return;
      }

      await runViaSSE(
        () => apiStream("/api/chat", { conversationId, content }),
        conversationId,
      );
    },
    [conversationId, setMessages, setIsStreaming, setStreamingMessage, setStreamError, runViaSSE],
  );

  const submitToolResult = useCallback(
    async (callId: string, result: ToolResult) => {
      if (!conversationId) return;

      setStreamError(null);
      setIsStreaming(true);
      setStreamingMessage("");
      accumulatedTextRef.current = "";

      const ws = wsRef.current;
      const useWs =
        ws &&
        ws.readyState === WebSocket.OPEN &&
        wsBoundConversationIdRef.current === conversationId;

      if (useWs) {
        try {
          ws.send(JSON.stringify({ type: "tool_result", callId, result }));
        } catch (err) {
          console.error("WebSocket tool_result send failed, SSE fallback:", err);
          await runViaSSE(
            () =>
              apiStream("/api/chat/tool-result", {
                conversationId,
                callId,
                result,
              }),
            conversationId,
          );
        }
        return;
      }

      await runViaSSE(
        () =>
          apiStream("/api/chat/tool-result", {
            conversationId,
            callId,
            result,
          }),
        conversationId,
      );
    },
    [conversationId, setIsStreaming, setStreamingMessage, setStreamError, runViaSSE],
  );

  return { sendMessage, submitToolResult };
}
