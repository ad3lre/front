/**
 * School-safe transport preference for OpenFront.
 * - auto: try WebSocket briefly, then fall back to HTTP poll
 * - poll: force HTTP long-poll (school proxies)
 * - ws:   never fall back (default upstream behavior)
 */
export type SchoolTransportMode = "auto" | "poll" | "ws";

const STORAGE_KEY = "settings.schoolTransport";
const LEGACY_KEY = "front.transport";

export const WS_OPEN_TIMEOUT_MS = 1_200;

export function readSchoolTransportMode(): SchoolTransportMode {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
    if (raw === "poll" || raw === "ws" || raw === "auto") return raw;
  } catch {
    /* ignore */
  }
  return "auto";
}

export function writeSchoolTransportMode(mode: SchoolTransportMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    // Keep the short key in sync for any sessionStorage-style readers.
    if (mode === "poll") sessionStorage.setItem(LEGACY_KEY, "poll");
    else sessionStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

/** Remember that this tab had to use poll (auto-fallback latch). */
export function latchPollTransport(): void {
  try {
    sessionStorage.setItem(LEGACY_KEY, "poll");
  } catch {
    /* ignore */
  }
}

export function shouldStartWithPoll(mode = readSchoolTransportMode()): boolean {
  if (mode === "poll") return true;
  if (mode === "ws") return false;
  try {
    return sessionStorage.getItem(LEGACY_KEY) === "poll";
  } catch {
    return false;
  }
}
