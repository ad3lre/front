/**
 * HTTP long-poll fallback when school proxies strip WebSocket Upgrade
 * (Octogate / Squid). Binary zbin frames, same handlers as real WS.
 *
 * Event-safe outbox policy (avoids the Land/Serpents coalesce bug):
 * - Game channel: never drop turns / intents / lobby_info / start / errors.
 *   Only identical `ping` frames may last-wins coalesce.
 * - Lobby channel: a new `full` snapshot clears prior full+counts (complete
 *   replace). `counts` deltas are never dropped — they must stay ordered.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import type { Logger } from "winston";
import type { WebSocketServer } from "ws";
import {
  decodeLobbyMessage,
  decodeServerMessage,
} from "@openfront/shared/ZbinWire";

const POLL_WAIT_MS = 12_000;
const SESSION_TTL_MS = 45_000;
const MAX_OUTBOX = 2_000;
const MAX_SESSIONS = 400;
const MAX_SESSIONS_PER_IP = Number(process.env.FRONT_POLL_MAX_PER_IP ?? 64);

type Channel = "game" | "lobbies";
type Waiter = (msgs: string[]) => void;

export class PollWebSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  bufferedAmount = 0;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";

  constructor(
    private readonly enqueue: (data: Buffer) => void,
    private readonly onCloseRequest: () => void,
  ) {
    super();
  }

  send(data: Buffer | Uint8Array | ArrayBuffer | string): void {
    if (this.readyState !== this.OPEN) return;
    let buf: Buffer;
    if (typeof data === "string") {
      buf = Buffer.from(data);
    } else if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (data instanceof ArrayBuffer) {
      buf = Buffer.from(data);
    } else {
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    this.enqueue(buf);
  }

  close(_code?: number, _reason?: string): void {
    this.onCloseRequest();
  }

  terminate(): void {
    this.onCloseRequest();
  }
}

type Session = {
  id: string;
  ip: string;
  channel: Channel;
  outbox: Buffer[];
  waiter: Waiter | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
  lastSeen: number;
  closed: boolean;
  ws: PollWebSocket | null;
};

const sessions = new Map<string, Session>();

function release(s: Session) {
  if (!s.waiter) return;
  const w = s.waiter;
  s.waiter = null;
  if (s.waitTimer) clearTimeout(s.waitTimer);
  s.waitTimer = null;
  const msgs = s.outbox.splice(0).map((b) => b.toString("base64"));
  w(msgs);
}

function lobbyKind(buf: Buffer): "full" | "counts" | "other" {
  try {
    const m = decodeLobbyMessage(new Uint8Array(buf));
    if (m.type === "full" || m.type === "counts") return m.type;
  } catch {
    /* keep */
  }
  return "other";
}

function isGamePing(buf: Buffer): boolean {
  try {
    return decodeServerMessage(new Uint8Array(buf), undefined).type === "ping";
  } catch {
    // Needs dictionary / unknown → treat as critical (never coalesce).
    return false;
  }
}

/**
 * Fold-safe enqueue. Critical for not dropping one-shot game/lobby deltas.
 */
function enqueue(s: Session, data: Buffer) {
  if (s.closed) return;

  if (s.channel === "lobbies") {
    const kind = lobbyKind(data);
    if (kind === "full") {
      // Complete snapshot: prior full + counts are obsolete.
      s.outbox.length = 0;
    }
    // counts / other: append in order — never drop earlier counts.
    s.outbox.push(data);
  } else {
    // game: only coalesce pings; never touch turns / start / lobby_info / …
    if (isGamePing(data)) {
      for (let i = s.outbox.length - 1; i >= 0; i--) {
        if (isGamePing(s.outbox[i]!)) s.outbox.splice(i, 1);
      }
    }
    s.outbox.push(data);
  }

  while (s.outbox.length > MAX_OUTBOX) {
    let dropped = false;
    if (s.channel === "game") {
      for (let i = 0; i < s.outbox.length - 1; i++) {
        if (isGamePing(s.outbox[i]!)) {
          s.outbox.splice(i, 1);
          dropped = true;
          break;
        }
      }
    } else {
      // Lobby overflow: drop an older full if a newer full exists later.
      let lastFull = -1;
      for (let i = s.outbox.length - 1; i >= 0; i--) {
        if (lobbyKind(s.outbox[i]!) === "full") {
          lastFull = i;
          break;
        }
      }
      for (let i = 0; i < lastFull; i++) {
        if (lobbyKind(s.outbox[i]!) === "full") {
          s.outbox.splice(i, 1);
          dropped = true;
          break;
        }
      }
    }
    if (!dropped) {
      // Last resort — should be rare with MAX_OUTBOX=2000 @ 10Hz.
      console.warn(
        `[school-poll] outbox overflow channel=${s.channel} size=${s.outbox.length}`,
      );
      s.outbox.splice(0, s.outbox.length - MAX_OUTBOX);
      break;
    }
  }
  release(s);
}

function endSession(s: Session, why?: string) {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  s.closed = true;
  release(s);
  const ws = s.ws;
  s.ws = null;
  if (ws) {
    ws.readyState = ws.CLOSED;
    try {
      ws.emit("close");
    } catch {
      /* ignore */
    }
    ws.removeAllListeners();
  }
  if (why) {
    console.log(`[school-poll] session ${s.id.slice(0, 8)} closed (${why})`);
  }
}

function fakeReq(ip: string, url: string): IncomingMessage {
  return {
    url,
    headers: { "cf-connecting-ip": ip },
    socket: { remoteAddress: ip },
  } as unknown as IncomingMessage;
}

function readJson(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // express.json may already have parsed
    if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Pragma", "no-cache");
}

export type SchoolPollDeps = {
  gameWss: WebSocketServer;
  lobbiesWss: WebSocketServer;
  clientIp: (req: Request | IncomingMessage) => string;
  log: Logger;
};

export function registerSchoolPoll(app: Express, deps: SchoolPollDeps): void {
  setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.waiter && now - s.lastSeen > SESSION_TTL_MS) {
        endSession(s, "timeout");
      }
    }
  }, 10_000).unref();

  app.post("/api/poll/open", async (req, res) => {
    noStore(res);
    try {
      const body = (await readJson(req)) as { channel?: string; platform?: string };
      const channel: Channel =
        body.channel === "lobbies" ? "lobbies" : "game";
      const ip = deps.clientIp(req);
      const ipCount = [...sessions.values()].filter((x) => x.ip === ip).length;
      if (sessions.size >= MAX_SESSIONS || ipCount >= MAX_SESSIONS_PER_IP) {
        deps.log.warn("school-poll session cap", {
          ip,
          ipCount,
          total: sessions.size,
        });
        res.status(429).json({ error: "too many poll sessions" });
        return;
      }

      const id = randomUUID();
      const s: Session = {
        id,
        ip,
        channel,
        outbox: [],
        waiter: null,
        waitTimer: null,
        lastSeen: Date.now(),
        closed: false,
        ws: null,
      };
      const ws = new PollWebSocket(
        (data) => enqueue(s, data),
        () => endSession(s, "server-close"),
      );
      s.ws = ws;
      sessions.set(id, s);

      const platform =
        typeof body.platform === "string" && body.platform
          ? body.platform
          : "web";
      const url =
        channel === "lobbies"
          ? `/lobbies?platform=${encodeURIComponent(platform)}`
          : `/`;
      const reqLike = fakeReq(ip, url);

      if (channel === "lobbies") {
        deps.lobbiesWss.emit("connection", ws, reqLike);
      } else {
        deps.gameWss.emit("connection", ws, reqLike);
      }

      res.json({ id, channel });
    } catch (err) {
      deps.log.warn("school-poll open failed", { err: String(err) });
      res.status(400).json({ error: "invalid_open" });
    }
  });

  app.post("/api/poll/send", async (req, res) => {
    noStore(res);
    try {
      const body = (await readJson(req)) as { id?: string; data?: string };
      const s = body.id ? sessions.get(body.id) : undefined;
      if (!s || s.closed || !s.ws) {
        res.status(404).json({ error: "unknown_session" });
        return;
      }
      s.lastSeen = Date.now();
      if (typeof body.data !== "string") {
        res.status(400).json({ error: "missing_data" });
        return;
      }
      const buf = Buffer.from(body.data, "base64");
      s.ws.emit("message", buf);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post("/api/poll/recv", async (req, res) => {
    noStore(res);
    try {
      const body = (await readJson(req)) as { id?: string };
      const s = body.id ? sessions.get(body.id) : undefined;
      if (!s || s.closed) {
        res.status(404).json({ error: "unknown_session" });
        return;
      }
      s.lastSeen = Date.now();
      if (s.outbox.length > 0) {
        res.json({ messages: s.outbox.splice(0).map((b) => b.toString("base64")) });
        return;
      }
      const messages = await new Promise<string[]>((resolve) => {
        s.waiter = resolve;
        s.waitTimer = setTimeout(() => {
          if (s.waiter === resolve) {
            s.waiter = null;
            s.waitTimer = null;
            resolve([]);
          }
        }, POLL_WAIT_MS);
      });
      res.json({ messages });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post("/api/poll/close", async (req, res) => {
    noStore(res);
    try {
      const body = (await readJson(req)) as { id?: string };
      const s = body.id ? sessions.get(body.id) : undefined;
      if (s) endSession(s, "client-close");
      res.json({ ok: true });
    } catch {
      res.json({ ok: true });
    }
  });
}
