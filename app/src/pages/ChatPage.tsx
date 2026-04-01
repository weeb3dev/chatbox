import ConversationList from "../components/chat/ConversationList";
import MessageList from "../components/chat/MessageList";
import ChatInput from "../components/chat/ChatInput";
import { useChat } from "../hooks/useChat";

export default function ChatPage() {
  const { sendMessage } = useChat();

  return (
    <div className="flex h-screen bg-gray-950">
      <ConversationList />

      <div className="flex flex-1 flex-col">
        <MessageList />
        <ChatInput onSend={sendMessage} />
      </div>

      {/* Right panel placeholder for Phase 4 app iframes */}
    </div>
  );
}
