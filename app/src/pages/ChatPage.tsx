import { useCallback, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import ConversationList from "../components/chat/ConversationList";
import MessageList from "../components/chat/MessageList";
import ChatInput from "../components/chat/ChatInput";
import AppContainer from "../components/apps/AppContainer";
import type { AppContainerHandle } from "../components/apps/AppContainer";
import { useChat } from "../hooks/useChat";
import { useAppBridge } from "../hooks/useAppBridge";
import { useAppSession } from "../hooks/useAppSession";
import {
  activeAppAtom,
  appContainerReadyAtom,
  appCircuitTickAtom,
} from "../stores/apps";
import { isAppDegraded } from "../lib/appCircuitBreaker";
import type { AppStateSummary } from "../types";

export default function ChatPage() {
  const { sendMessage } = useChat();
  const { setContainerRef, closeApp } = useAppBridge();
  const { endAppSession, updateSessionState } = useAppSession();
  const activeApp = useAtomValue(activeAppAtom);
  const circuitTick = useAtomValue(appCircuitTickAtom);
  const setContainerReady = useSetAtom(appContainerReadyAtom);
  // circuitTick is read so component re-renders when the breaker trips
  const degradedWarning = useMemo(
    () => activeApp != null && isAppDegraded(activeApp.appId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeApp, circuitTick],
  );

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [minimizedForSessionId, setMinimizedForSessionId] = useState<
    string | null
  >(null);
  const appMinimized =
    !!activeApp && minimizedForSessionId === activeApp.sessionId;
  const setAppMinimized = useCallback(
    (min: boolean) => {
      if (!activeApp) return;
      setMinimizedForSessionId(min ? activeApp.sessionId : null);
    },
    [activeApp],
  );

  const handleContainerRef = useCallback(
    (handle: AppContainerHandle | null) => {
      setContainerRef(handle);
    },
    [setContainerRef],
  );

  const handleReady = useCallback(() => {
    setContainerReady(true);
  }, [setContainerReady]);

  const handleClose = useCallback(async () => {
    if (activeApp) {
      await endAppSession(activeApp.sessionId);
    }
    await closeApp();
    setContainerReady(false);
    setMinimizedForSessionId(null);
  }, [activeApp, endAppSession, closeApp, setContainerReady]);

  const handleStateUpdate = useCallback(
    (state: AppStateSummary) => {
      if (activeApp) {
        updateSessionState(activeApp.sessionId, state);
      }
    },
    [activeApp, updateSessionState],
  );

  const handleCompletion = useCallback(
    (event: string, summary: string) => {
      if (activeApp) {
        endAppSession(activeApp.sessionId, event, summary);
      }
      closeApp();
      setContainerReady(false);
      setMinimizedForSessionId(null);
    },
    [activeApp, endAppSession, closeApp, setContainerReady],
  );

  return (
    <div className="flex h-screen min-h-0 bg-bg-app text-gray-100">
      <aside className="hidden h-full w-64 shrink-0 md:block">
        <ConversationList />
      </aside>

      {sidebarOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/55 md:hidden"
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 w-64 max-w-[85vw] shadow-2xl md:hidden">
            <ConversationList
              onConversationSelected={() => setSidebarOpen(false)}
              className="h-full border-r border-border shadow-xl"
            />
          </div>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-2 md:hidden">
          <button
            type="button"
            className="rounded-md p-2 text-gray-300 hover:bg-surface-hover"
            aria-label="Open conversations"
            onClick={() => setSidebarOpen(true)}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          <span className="text-sm font-medium text-gray-300">ChatBridge</span>
        </header>

        <div
          className={`flex min-h-0 flex-1 flex-col ${
            activeApp ? "lg:flex-row" : ""
          }`}
        >
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <MessageList />
            <ChatInput onSend={sendMessage} />
          </section>

          {activeApp && (
            <div
              className={`shrink-0 border-border bg-bg-app lg:min-h-0 ${
                appMinimized
                  ? "cb-offscreen-keep-alive"
                  : "cb-app-panel-enter max-lg:h-[min(45vh,440px)] max-lg:w-full max-lg:border-t lg:h-full lg:w-[350px] lg:border-l lg:border-t-0"
              }`}
              aria-hidden={appMinimized || undefined}
            >
              <AppContainer
                key={activeApp.sessionId}
                ref={handleContainerRef}
                manifest={activeApp.manifest}
                sessionId={activeApp.sessionId}
                onClose={handleClose}
                onMinimize={() => setAppMinimized(true)}
                onStateUpdate={handleStateUpdate}
                onCompletion={handleCompletion}
                onReady={handleReady}
                degradedWarning={degradedWarning}
              />
            </div>
          )}
        </div>
      </div>

      {activeApp && appMinimized && (
        <div className="fixed bottom-4 left-4 right-4 z-30 flex justify-center md:left-auto md:right-6 md:w-auto">
          <div className="flex max-w-md items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 shadow-lg ring-1 ring-black/20">
            <span className="max-w-[40vw] truncate text-sm text-gray-200 md:max-w-[12rem]">
              {activeApp.manifest.name}
            </span>
            <button
              type="button"
              onClick={() => setAppMinimized(false)}
              className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-light"
            >
              Expand
            </button>
            <button
              type="button"
              onClick={() => void handleClose()}
              className="rounded-full px-2 py-1 text-xs text-gray-400 hover:bg-surface-hover hover:text-gray-200"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
