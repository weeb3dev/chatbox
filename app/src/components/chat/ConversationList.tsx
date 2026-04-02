import { useEffect, useCallback } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { conversationsAtom, activeConversationIdAtom } from "../../stores/conversations";
import {
  messagesAtom,
  isStreamingAtom,
  streamingMessageAtom,
  streamErrorAtom,
} from "../../stores/chat";
import { authTokenAtom, userAtom } from "../../stores/auth";
import { useNavigate } from "@tanstack/react-router";
import { apiFetch } from "../../lib/api";
import type { Conversation, Message } from "../../types";

export default function ConversationList() {
  const [conversations, setConversations] = useAtom(conversationsAtom);
  const [activeId, setActiveId] = useAtom(activeConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  const setStreaming = useSetAtom(isStreamingAtom);
  const setStreamingMsg = useSetAtom(streamingMessageAtom);
  const setStreamError = useSetAtom(streamErrorAtom);
  const setToken = useSetAtom(authTokenAtom);
  const user = useAtomValue(userAtom);
  const navigate = useNavigate();

  useEffect(() => {
    apiFetch<Conversation[]>("/api/conversations").then(setConversations).catch(() => {});
  }, [setConversations]);

  const selectConversation = useCallback(
    async (id: string) => {
      setActiveId(id);
      setStreaming(false);
      setStreamingMsg("");
      setStreamError(null);
      try {
        const data = await apiFetch<{ messages: Message[] }>(
          `/api/conversations/${id}`,
        );
        setMessages(data.messages ?? []);
      } catch {
        setMessages([]);
      }
    },
    [setActiveId, setMessages, setStreaming, setStreamingMsg, setStreamError],
  );

  async function createConversation() {
    try {
      const conv = await apiFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "New conversation" }),
      });
      setConversations((prev) => [conv, ...prev]);
      selectConversation(conv.id);
    } catch {
      /* ignore */
    }
  }

  async function deleteConversation(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    try {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setStreamError(null);
      }
    } catch {
      /* ignore */
    }
  }

  function logout() {
    setToken(null);
    navigate({ to: "/login" });
  }

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-surface">
      <div className="p-3">
        <button
          onClick={createConversation}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-light transition-colors"
        >
          + New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            onClick={() => selectConversation(conv.id)}
            className={`group flex cursor-pointer items-center justify-between px-3 py-2.5 text-sm transition-colors ${
              activeId === conv.id
                ? "bg-surface-hover text-gray-100"
                : "text-gray-400 hover:bg-surface-alt hover:text-gray-200"
            }`}
          >
            <span className="truncate">{conv.title || "Untitled"}</span>
            <button
              onClick={(e) => deleteConversation(e, conv.id)}
              className="ml-2 hidden shrink-0 rounded p-0.5 text-gray-500 hover:bg-red-900/40 hover:text-red-400 group-hover:block"
              title="Delete"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-gray-500">{user?.email}</span>
          <button
            onClick={logout}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
