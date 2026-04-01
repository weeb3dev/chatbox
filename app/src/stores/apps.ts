import { atom } from "jotai";
import type { App, AppSession } from "../types";

export const availableAppsAtom = atom<App[]>([]);

export const activeAppSessionsAtom = atom<AppSession[]>([]);
