import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { messagesAtom, streamingMessageAtom, isStreamingAtom } from "../../stores/chat";
import { activeConversationIdAtom } from "../../stores/conversations";
import type { Message } from "../../types";

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "tool_result") return null;

  if (message.role === "tool_call") {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-surface-alt px-3 py-1 text-xs text-gray-500 italic">
          Using {message.toolName ?? "app"}...
        </span>
      </div>
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-accent text-white rounded-br-md"
            : "bg-surface-alt text-gray-200 rounded-bl-md"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[75%] rounded-2xl rounded-bl-md bg-surface-alt px-4 py-2.5 text-sm leading-relaxed text-gray-200 whitespace-pre-wrap">
        {text}
        <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-gray-400" />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start mb-3">
      <div className="rounded-2xl rounded-bl-md bg-surface-alt px-4 py-3">
        <div className="flex space-x-1.5">
          <div className="h-2 w-2 rounded-full bg-gray-500 animate-bounce [animation-delay:0ms]" />
          <div className="h-2 w-2 rounded-full bg-gray-500 animate-bounce [animation-delay:150ms]" />
          <div className="h-2 w-2 rounded-full bg-gray-500 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

export default function MessageList() {
  const messages = useAtomValue(messagesAtom);
  const streamingText = useAtomValue(streamingMessageAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const activeId = useAtomValue(activeConversationIdAtom);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  if (!activeId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium text-gray-400">ChatBridge</h2>
          <p className="mt-1 text-sm text-gray-600">
            Select a conversation or start a new one
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isStreaming && streamingText && <StreamingBubble text={streamingText} />}
      {isStreaming && !streamingText && <TypingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
