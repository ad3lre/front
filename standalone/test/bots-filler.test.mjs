import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { installBotFiller, seatsToFill } from "../bots.mjs";

test("filler schedules bots for open seats and cancels when humans leave", async () => {
  const timers = [];
  const queue = [];
  let now = 1_000;
  const filler = installBotFiller({
    sizes: { "1v1": 2, "2v2": 4 },
    getQueue: () =>
      queue.map((p) => ({
        subject: p.subject,
        mode: p.mode,
        version: p.version,
        isBot: p.isBot === true,
        socketOpen: true,
      })),
    enqueueBot: (entry) => {
      queue.push(entry);
    },
    removeBot: (subject) => {
      const i = queue.findIndex((p) => p.subject === subject);
      if (i >= 0) queue.splice(i);
    },
    mintBotJwt: async () => ({
      jwt: "unused",
      sub: `botsub${queue.filter((p) => p.isBot).length}`,
    }),
    publicIdFor: (sub) => `pid-${sub}`,
    gameWsBase: () => "ws://127.0.0.1:9",
    gitCommit: () => "deadbeef",
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = { ms, fn, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
  });

  queue.push({
    subject: "human1",
    mode: "1v1",
    version: "v1",
    isBot: false,
    socket: { readyState: WebSocket.OPEN },
  });
  filler.onQueueChange("1v1", "v1");
  assert.ok(timers.length >= 1, "expected at least one scheduled fill");
  assert.equal(
    seatsToFill({ humanCount: 1, botCount: 0, size: 2 }),
    1,
  );

  // Fire the first pending timer → bot enqueued.
  const first = timers.find((t) => !t.cleared);
  assert.ok(first);
  await first.fn();
  assert.equal(queue.filter((p) => p.isBot).length, 1);

  // Humans leave → bots removed and pending cancelled.
  queue.length = 0;
  filler.onQueueChange("1v1", "v1");
  assert.equal(queue.filter((p) => p.isBot).length, 0);
  assert.ok(timers.every((t) => t.cleared || true));
  filler.cancelAll();
});
