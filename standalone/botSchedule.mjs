import { ANON_WORDS } from "@openfront/shared/AnonNames";

export const FILL_WINDOW_MS = 28_000;
export const SURGE_TAIL_MS = 4_000;

/**
 * Delays (ms) for filling `openSeats` so the queue feels alive: one seat often
 * arrives almost immediately, a minority trickle through the middle of the
 * window, and most surge in during the last few seconds.
 */
export function planFillDelays(
  openSeats,
  fillWindowMs = FILL_WINDOW_MS,
  rng = Math.random,
) {
  if (openSeats <= 0) return [];
  const delays = [];
  let remaining = openSeats;

  // First open seat: usually instant so a lone human sees company quickly.
  if (remaining > 0 && rng() < 0.9) {
    delays.push(400 + rng() * 1_600);
    remaining -= 1;
  }

  for (let i = 0; i < remaining; i++) {
    if (rng() < 0.3) {
      const midStart = fillWindowMs * 0.2;
      const midEnd = fillWindowMs * 0.7;
      delays.push(midStart + rng() * (midEnd - midStart));
    } else {
      const surgeStart = Math.max(0, fillWindowMs - SURGE_TAIL_MS);
      delays.push(surgeStart + rng() * (fillWindowMs - surgeStart));
    }
  }

  return delays.sort((a, b) => a - b);
}

export function botUsername(slot) {
  const word = ANON_WORDS[Math.abs(slot) % ANON_WORDS.length];
  return `Bot${word}`;
}

/**
 * Pure view of how many bot fills a waiting group still needs.
 * Humans only — never schedule bot-vs-bot matches.
 */
export function seatsToFill({ humanCount, botCount, size }) {
  if (humanCount < 1) return 0;
  return Math.max(0, size - humanCount - botCount);
}
