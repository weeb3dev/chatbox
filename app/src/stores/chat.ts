import { atom } from "jotai";
import type { Message, ServerMessage } from "../types";

export const messagesAtom = atom<Message[]>([]);

export const isStreamingAtom = atom<boolean>(false);

export const streamingMessageAtom = atom<string>("");

export const pendingToolCallAtom = atom<
  (ServerMessage & { type: "tool_invoke" }) | null
>(null);

/** While the app iframe is executing a tool (after server tool_invoke until tool_result is sent). */
export const toolInvocationBusyAtom = atom<{
  tool: string;
  displayLabel: string;
} | null>(null);

/** Set when SSE stream reports error or fetch fails; cleared on send/dismiss. */
export const streamErrorAtom = atom<string | null>(null);
