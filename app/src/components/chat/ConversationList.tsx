import { useEffect, useCallback, useState } from "react";
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

function ConversationSkeletonRows() {
  return (
    <div className="space-y-2 px-3 py-1" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-md bg-surface-alt/80"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}

export interface ConversationListProps {
  /** Call when user picks a conversation (e.g. close mobile drawer). */
  onConversationSelected?: () => void;
  className?: string;
}

export default function ConversationList({
  onConversationSelected,
  className = "",
}: ConversationListProps) {
  const [conversations, setConversations] = useAtom(conversationsAtom);
  const [activeId, setActiveId] = useAtom(activeConversationIdAtom);
  const setMessages = useSetAtom(messagesAtom);
  const setStreaming = useSetAtom(isStreamingAtom);
  const setStreamingMsg = useSetAtom(streamingMessageAtom);
  const setStreamError = useSetAtom(streamErrorAtom);
  const setToken = useSetAtom(authTokenAtom);
  const user = useAtomValue(userAtom);
  const navigate = useNavigate();
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const loadConversations = useCallback(() => {
    setListLoading(true);
    setListError(null);
    apiFetch<Conversation[]>("/api/conversations")
      .then((data) => {
        setConversations(data);
        setListError(null);
      })
      .catch(() => {
        setListError("Could not load conversations");
      })
      .finally(() => {
        setListLoading(false);
      });
  }, [setConversations]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Conversation[]>("/api/conversations")
      .then((data) => {
        if (cancelled) return;
        setConversations(data);
        setListError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setListError("Could not load conversations");
      })
      .finally(() => {
        if (cancelled) return;
        setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setConversations]);

  const selectConversation = useCallback(
    async (id: string) => {
      setActiveId(id);
      setStreaming(false);
      setStreamingMsg("");
      setStreamError(null);
      onConversationSelected?.();
      try {
        const data = await apiFetch<{ messages: Message[] }>(
          `/api/conversations/${id}`,
        );
        setMessages(data.messages ?? []);
      } catch {
        setMessages([]);
      }
    },
    [
      setActiveId,
      setMessages,
      setStreaming,
      setStreamingMsg,
      setStreamError,
      onConversationSelected,
    ],
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
    <div
      className={`flex h-full w-64 flex-col border-r border-border bg-surface ${className}`}
    >
      <div className="p-3">
        <button
          onClick={createConversation}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-light transition-colors"
        >
          + New Chat
        </button>
      </div>

      {listError && (
        <div className="mx-3 mb-2 rounded-md border border-red-900/40 bg-red-950/30 px-2 py-2 text-xs text-red-200/90">
          <p>{listError}</p>
          <button
            type="button"
            onClick={loadConversations}
            className="mt-1.5 text-red-300 underline hover:text-red-100"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {listLoading && <ConversationSkeletonRows />}
        {!listLoading &&
          conversations.map((conv) => (
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
        {!listLoading && conversations.length === 0 && !listError && (
          <p className="px-3 py-4 text-center text-xs text-gray-500">
            No conversations yet
          </p>
        )}
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
