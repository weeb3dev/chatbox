import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeConversationIdAtom } from "../stores/conversations";
import {
  messagesAtom,
  isStreamingAtom,
  streamingMessageAtom,
  pendingToolCallAtom,
} from "../stores/chat";
import { apiStream } from "../lib/api";
import type { Message, ServerMessage, ToolResult } from "../types";

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

  const sendMessage = useCallback(
    async (content: string) => {
      if (!conversationId) return;

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

      let accumulatedText = "";

      try {
        const response = await apiStream("/api/chat", {
          conversationId,
          content,
        });

        await consumeSSEStream(
          response,
          (chunk) => {
            accumulatedText += chunk;
            setStreamingMessage(accumulatedText);
          },
          (toolEvent) => {
            setPendingToolCall(toolEvent);
          },
          (messageId) => {
            if (accumulatedText) {
              const assistantMsg: Message = {
                id: messageId,
                conversationId,
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
            setStreamingMessage("");
            setIsStreaming(false);
          },
          (errorMsg) => {
            console.error("Chat stream error:", errorMsg);
            setStreamingMessage("");
            setIsStreaming(false);
          },
        );
      } catch (err) {
        console.error("Chat request failed:", err);
        setStreamingMessage("");
        setIsStreaming(false);
      }
    },
    [conversationId, setMessages, setIsStreaming, setStreamingMessage, setPendingToolCall],
  );

  const submitToolResult = useCallback(
    async (callId: string, result: ToolResult) => {
      if (!conversationId) return;

      setIsStreaming(true);
      setStreamingMessage("");
      let accumulatedText = "";

      try {
        const response = await apiStream("/api/chat/tool-result", {
          conversationId,
          callId,
          result,
        });

        await consumeSSEStream(
          response,
          (chunk) => {
            accumulatedText += chunk;
            setStreamingMessage(accumulatedText);
          },
          (toolEvent) => {
            setPendingToolCall(toolEvent);
          },
          (messageId) => {
            if (accumulatedText) {
              const assistantMsg: Message = {
                id: messageId,
                conversationId,
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
            setStreamingMessage("");
            setIsStreaming(false);
          },
          (errorMsg) => {
            console.error("Tool result stream error:", errorMsg);
            setStreamingMessage("");
            setIsStreaming(false);
          },
        );
      } catch (err) {
        console.error("Tool result request failed:", err);
        setStreamingMessage("");
        setIsStreaming(false);
      }
    },
    [conversationId, setMessages, setIsStreaming, setStreamingMessage, setPendingToolCall],
  );

  return { sendMessage, submitToolResult };
}
