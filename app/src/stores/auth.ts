import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const authTokenAtom = atomWithStorage<string | null>(
  "chatbridge_token",
  null,
);

interface DecodedUser {
  userId: string;
  email: string;
}

function decodeJWTPayload(token: string): DecodedUser & { exp: number } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  return payload;
}

export const userAtom = atom<DecodedUser | null>((get) => {
  const token = get(authTokenAtom);
  if (!token) return null;
  try {
    const { userId, email } = decodeJWTPayload(token);
    return { userId, email };
  } catch {
    return null;
  }
});

export const isAuthenticatedAtom = atom<boolean>((get) => {
  const token = get(authTokenAtom);
  if (!token) return false;
  try {
    const { exp } = decodeJWTPayload(token);
    return exp * 1000 > Date.now();
  } catch {
    return false;
  }
});
