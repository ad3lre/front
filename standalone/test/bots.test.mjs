import assert from "node:assert/strict";
import test from "node:test";
import {
  botUsername,
  planFillDelays,
  seatsToFill,
  FILL_WINDOW_MS,
  SURGE_TAIL_MS,
} from "../botSchedule.mjs";

test("planFillDelays returns one delay per open seat", () => {
  assert.equal(planFillDelays(0).length, 0);
  assert.equal(planFillDelays(1, FILL_WINDOW_MS, () => 0.5).length, 1);
  assert.equal(planFillDelays(3, FILL_WINDOW_MS, () => 0.5).length, 3);
});

test("planFillDelays sorts ascending and stays within the window", () => {
  let i = 0;
  const seq = [0.1, 0.2, 0.9, 0.4, 0.6, 0.8, 0.3, 0.5];
  const rng = () => seq[i++ % seq.length];
  const delays = planFillDelays(4, FILL_WINDOW_MS, rng);
  assert.equal(delays.length, 4);
  for (let j = 1; j < delays.length; j++) {
    assert.ok(delays[j] >= delays[j - 1]);
  }
  for (const d of delays) {
    assert.ok(d >= 0);
    assert.ok(d <= FILL_WINDOW_MS);
  }
});

test("planFillDelays puts most fills in the surge tail when rng prefers surge", () => {
  // Sequence: pass instant gate (0.05 < 0.9), then pick instant delay,
  // then fail trickle gate (0.95 >= 0.3) three times for surge seats.
  const seq = [0.05, 0.5, 0.95, 0.5, 0.95, 0.5, 0.95, 0.5];
  let i = 0;
  const delays = planFillDelays(4, FILL_WINDOW_MS, () => seq[i++ % seq.length]);
  assert.equal(delays.length, 4);
  const surgeStart = FILL_WINDOW_MS - SURGE_TAIL_MS;
  const surgeCount = delays.filter((d) => d >= surgeStart).length;
  assert.ok(surgeCount >= 2, `expected surge majority, got ${delays}`);
  assert.ok(delays[0] < 3_000, `expected an early seat, got ${delays[0]}`);
});

test("seatsToFill never schedules without a human", () => {
  assert.equal(seatsToFill({ humanCount: 0, botCount: 0, size: 2 }), 0);
  assert.equal(seatsToFill({ humanCount: 0, botCount: 1, size: 2 }), 0);
  assert.equal(seatsToFill({ humanCount: 1, botCount: 0, size: 2 }), 1);
  assert.equal(seatsToFill({ humanCount: 1, botCount: 1, size: 2 }), 0);
  assert.equal(seatsToFill({ humanCount: 2, botCount: 0, size: 4 }), 2);
  assert.equal(seatsToFill({ humanCount: 1, botCount: 2, size: 4 }), 1);
});

test("botUsername draws from the anon bank with a Bot prefix", () => {
  assert.match(botUsername(0), /^Bot[A-Z][a-z]+/);
  assert.notEqual(botUsername(0), botUsername(1));
});
