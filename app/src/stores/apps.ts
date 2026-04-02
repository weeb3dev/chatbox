import { atom } from "jotai";
import type { App, AppSession, AppManifest } from "../types";

export const availableAppsAtom = atom<App[]>([]);

export const activeAppSessionsAtom = atom<AppSession[]>([]);

export interface ActiveApp {
  manifest: AppManifest;
  sessionId: string;
  appId: string;
}

export const activeAppAtom = atom<ActiveApp | null>(null);

export const appContainerReadyAtom = atom<boolean>(false);

/** Bumped when app circuit breaker state changes so UI can re-read thresholds. */
export const appCircuitTickAtom = atom(0);
