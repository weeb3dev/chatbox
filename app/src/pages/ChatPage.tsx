import { useCallback, useRef } from "react";
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
} from "../stores/apps";
import type { AppStateSummary } from "../types";

export default function ChatPage() {
  const { sendMessage } = useChat();
  const { setContainerRef, closeApp } = useAppBridge();
  const { endAppSession, updateSessionState } = useAppSession();
  const activeApp = useAtomValue(activeAppAtom);
  const setContainerReady = useSetAtom(appContainerReadyAtom);
  const containerHandleRef = useRef<AppContainerHandle>(null);

  const handleContainerRef = useCallback(
    (handle: AppContainerHandle | null) => {
      containerHandleRef.current = handle;
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
    },
    [activeApp, endAppSession, closeApp, setContainerReady],
  );

  return (
    <div className="flex h-screen bg-gray-950">
      <ConversationList />

      <div className="flex flex-1 flex-col">
        <MessageList />
        <ChatInput onSend={sendMessage} />
      </div>

      {activeApp && (
        <div className="w-[350px] shrink-0 border-l border-gray-800">
          <AppContainer
            ref={handleContainerRef}
            manifest={activeApp.manifest}
            sessionId={activeApp.sessionId}
            onClose={handleClose}
            onStateUpdate={handleStateUpdate}
            onCompletion={handleCompletion}
            onReady={handleReady}
          />
        </div>
      )}
    </div>
  );
}
