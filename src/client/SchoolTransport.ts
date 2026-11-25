/**
 * School-safe transport preference for OpenFront.
 * - auto: try WebSocket briefly, then fall back to HTTP poll
 * - poll: force HTTP long-poll (school proxies)
 * - ws:   never fall back (default upstream behavior)
 */
export type SchoolTransportMode = "auto" | "poll" | "ws";

const STORAGE_KEY = "settings.schoolTransport";
const LEGACY_KEY = "front.transport";

// Cellular / CGNAT paths often need >1s before Upgrade completes. A too-low
// value falsely falls back to school-poll; keep this above typical mobile RTT.
export const WS_OPEN_TIMEOUT_MS = 3_000;

/** In-memory only: sticky sessionStorage latch trapped tabs on poll forever. */
let autoPollLatch = false;

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

/**
 * Remember that THIS connect attempt must use poll (WS just failed). Cleared
 * on the next reconnect schedule so WebSocket is tried again — cellular often
 * accepts Upgrade on retry, and poll is a worse realtime path.
 */
export function latchPollTransport(): void {
  autoPollLatch = true;
}

export function clearPollTransportLatch(): void {
  autoPollLatch = false;
  try {
    // Drop sticky latches left by older builds so a refresh retries WebSocket.
    if (readSchoolTransportMode() !== "poll") {
      sessionStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function shouldStartWithPoll(mode = readSchoolTransportMode()): boolean {
  if (mode === "poll") return true;
  if (mode === "ws") return false;
  return autoPollLatch;
}

// Migrate tabs that were stuck on sessionStorage poll from older builds.
clearPollTransportLatch();
