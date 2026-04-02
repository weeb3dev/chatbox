import { useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeConversationIdAtom } from "../stores/conversations";
import { activeAppSessionsAtom, activeAppAtom } from "../stores/apps";
import { apiFetch } from "../lib/api";
import type { AppSession, AppStateSummary } from "../types";

export function useAppSession() {
  const conversationId = useAtomValue(activeConversationIdAtom);
  const setActiveAppSessions = useSetAtom(activeAppSessionsAtom);
  const setActiveApp = useSetAtom(activeAppAtom);

  useEffect(() => {
    if (!conversationId) {
      setActiveAppSessions([]);
      return;
    }

    (async () => {
      try {
        const data = await apiFetch<{
          messages: unknown[];
          appSessions: AppSession[];
        }>(`/api/conversations/${conversationId}`);
        if (data.appSessions) {
          setActiveAppSessions(data.appSessions);
        }
      } catch {
        /* conversation fetch may not include sessions yet */
      }
    })();
  }, [conversationId, setActiveAppSessions]);

  const endAppSession = useCallback(
    async (sessionId: string, event?: string, summary?: string) => {
      try {
        await apiFetch(`/api/app-sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "completed",
            stateSummary: summary ?? event ?? "Session completed",
          }),
        });
        setActiveAppSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId ? { ...s, status: "completed" as const } : s,
          ),
        );
        setActiveApp(null);
      } catch (err) {
        console.error("Failed to end app session:", err);
      }
    },
    [setActiveAppSessions, setActiveApp],
  );

  const updateSessionState = useCallback(
    async (sessionId: string, state: AppStateSummary) => {
      try {
        await apiFetch(`/api/app-sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stateSummary: state.display,
            stateRaw: JSON.stringify(state.raw),
          }),
        });
        setActiveAppSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, stateSummary: state.display, stateRaw: JSON.stringify(state.raw) }
              : s,
          ),
        );
      } catch (err) {
        console.error("Failed to update session state:", err);
      }
    },
    [setActiveAppSessions],
  );

  return { endAppSession, updateSessionState };
}
