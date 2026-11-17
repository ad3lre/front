import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  botUsername,
  FILL_WINDOW_MS,
  planFillDelays,
  seatsToFill,
} from "./botSchedule.mjs";

// Lazy: @openfront/shared zbin codecs need tsx; the API process may boot under
// plain node and only load these when a bot actually joins a game.
async function zbin() {
  return import("@openfront/shared/ZbinWire");
}

export {
  botUsername,
  FILL_WINDOW_MS,
  planFillDelays,
  seatsToFill,
  SURGE_TAIL_MS,
} from "./botSchedule.mjs";

/**
 * Matchmaking bot fleet: schedules fills when humans wait, joins the queue
 * with bot JWTs, then connects to the matched game and stays alive while the
 * sim's NationExecution drives play.
 */
export function installBotFiller({
  sizes,
  getQueue,
  enqueueBot,
  removeBot,
  mintBotJwt,
  publicIdFor,
  gameWsBase,
  gitCommit,
  log = console,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** @type {Map<string, { timers: ReturnType<typeof setTimeout>[], startedAt: number }>} */
  const plans = new Map();
  /** @type {Map<string, { ws: WebSocket, username: string }>} */
  const liveGames = new Map();

  function bucketKey(mode, version) {
    return `${mode}\0${version}`;
  }

  function cancelPlan(key) {
    const plan = plans.get(key);
    if (!plan) return;
    for (const t of plan.timers) clearTimer(t);
    plans.delete(key);
  }

  function snapshot(mode, version) {
    const entries = getQueue().filter(
      (p) => p.mode === mode && p.version === version && p.socketOpen,
    );
    return {
      humanCount: entries.filter((p) => !p.isBot).length,
      botCount: entries.filter((p) => p.isBot).length,
      bots: entries.filter((p) => p.isBot),
    };
  }

  function reconcile(mode, version) {
    const size = sizes[mode];
    if (!size) return;
    const key = bucketKey(mode, version);
    const { humanCount, botCount, bots } = snapshot(mode, version);

    // No humans left: drop bots and cancel pending fills (no bot-vs-bot).
    if (humanCount === 0) {
      cancelPlan(key);
      for (const bot of bots) removeBot(bot.subject);
      return;
    }

    const needed = seatsToFill({ humanCount, botCount, size });
    if (needed === 0) {
      cancelPlan(key);
      return;
    }

    const existing = plans.get(key);
    const pending = existing?.timers.length ?? 0;
    const stillNeeded = needed - pending;
    if (stillNeeded <= 0) return;

    const startedAt = existing?.startedAt ?? now();
    const elapsed = Math.max(0, now() - startedAt);
    const windowLeft = Math.max(1_000, FILL_WINDOW_MS - elapsed);
    const delays = planFillDelays(stillNeeded, windowLeft);
    const timers = existing?.timers ?? [];

    for (const delay of delays) {
      const timer = setTimer(() => {
        const idx = timers.indexOf(timer);
        if (idx >= 0) timers.splice(idx, 1);
        if (timers.length === 0) plans.delete(key);

        const snap = snapshot(mode, version);
        if (seatsToFill({ ...snap, size }) <= 0) return;
        if (snap.humanCount < 1) return;

        void spawnBot(mode, version).catch((err) =>
          log.warn?.("bot spawn failed", err) ?? console.warn("bot spawn failed", err),
        );
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
      timers.push(timer);
    }

    plans.set(key, { timers, startedAt });
  }

  async function spawnBot(mode, version) {
    const { jwt, sub } = await mintBotJwt();
    const publicId = publicIdFor(sub);
    const username = botUsername(
      Math.abs(
        [...sub].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0),
      ),
    );

    const adapter = {
      readyState: WebSocket.OPEN,
      username,
      close() {
        this.readyState = WebSocket.CLOSED;
      },
      send(raw) {
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (message?.type === "match-assignment" && typeof message.gameId === "string") {
          void joinGame(jwt, username, message.gameId, sub).catch((err) =>
            log.warn?.("bot game join failed", err) ??
              console.warn("bot game join failed", err),
          );
        }
      },
    };

    enqueueBot({
      subject: sub,
      socket: adapter,
      mode,
      version,
      publicId,
      isBot: true,
      username,
    });
  }

  async function joinGame(jwt, username, gameId, subject) {
    if (liveGames.has(subject)) return;
    const {
      createGameWireContext,
      decodeServerMessage,
      encodeClientMessage,
    } = await zbin();
    const base = gameWsBase().replace(/\/$/, "");
    const ws = new WebSocket(base);
    liveGames.set(subject, { ws, username });

    const cleanup = () => {
      liveGames.delete(subject);
    };
    ws.on("error", cleanup);
    ws.on("close", cleanup);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bot game open timeout")), 10_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.send(
      encodeClientMessage(
        {
          type: "join",
          gameID: gameId,
          token: jwt,
          username,
          clanTag: null,
          turnstileToken: null,
          gitCommit: gitCommit(),
        },
        undefined,
      ),
    );

    let ctx;
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(ping);
        return;
      }
      try {
        ws.send(encodeClientMessage({ type: "ping" }, ctx));
      } catch {
        clearInterval(ping);
      }
    }, 5_000);
    if (typeof ping.unref === "function") ping.unref();

    ws.on("message", (data) => {
      try {
        const msg = decodeServerMessage(
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data),
          ctx,
        );
        if (msg.type === "start") {
          ctx = createGameWireContext(msg.gameStartInfo.players);
        }
        if (msg.type === "error") {
          log.warn?.("bot game error", msg.error);
          ws.close();
        }
      } catch {
        /* ignore decode races before start */
      }
    });
  }

  return {
    onQueueChange(mode, version) {
      reconcile(mode, version);
    },
    /** Test helper: cancel every pending fill. */
    cancelAll() {
      for (const key of [...plans.keys()]) cancelPlan(key);
    },
    plans,
  };
}

/** Mint a base64url UUID subject suitable for TokenPayloadSchema. */
export function newBotSubject() {
  return Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString(
    "base64url",
  );
}
