/** Rolling window and thresholds (browser session, per tab). */
const WINDOW_MS = 5 * 60 * 1000;
const DEGRADED_THRESHOLD = 3;
const DISABLED_THRESHOLD = 10;

const failureTimestamps = new Map<string, number[]>();

function prune(appId: string): number[] {
  const now = Date.now();
  const arr = failureTimestamps.get(appId) ?? [];
  const next = arr.filter((t) => now - t <= WINDOW_MS);
  failureTimestamps.set(appId, next);
  return next;
}

export function recordAppFailure(appId: string): void {
  const next = prune(appId);
  next.push(Date.now());
  failureTimestamps.set(appId, next);
}

export function recordAppSuccess(appId: string): void {
  failureTimestamps.set(appId, []);
}

export function isAppDisabled(appId: string): boolean {
  return prune(appId).length >= DISABLED_THRESHOLD;
}

export function isAppDegraded(appId: string): boolean {
  const n = prune(appId).length;
  return n >= DEGRADED_THRESHOLD && n < DISABLED_THRESHOLD;
}

export function getAppFailureCount(appId: string): number {
  return prune(appId).length;
}
