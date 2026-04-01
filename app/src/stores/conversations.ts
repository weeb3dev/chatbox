import { atom } from "jotai";
import type { Conversation } from "../types";

export const conversationsAtom = atom<Conversation[]>([]);

export const activeConversationIdAtom = atom<string | null>(null);

export const activeConversationAtom = atom<Conversation | null>((get) => {
  const id = get(activeConversationIdAtom);
  if (!id) return null;
  return get(conversationsAtom).find((c) => c.id === id) ?? null;
});
