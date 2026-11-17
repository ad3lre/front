/**
 * Browser WebSocket look-alike over HTTP long-poll (school Octogate/Squid).
 * Carries the same binary zbin frames as the real game/lobby sockets.
 */
import { clientPlatform } from "./ClientPlatform";

export type SchoolPollChannel = "game" | "lobbies";

const DEFAULT_WAIT_MS = 15_000;

function b64FromBuffer(buf: ArrayBuffer | Uint8Array): string {
  const bytes =
    buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function bufferFromB64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class SchoolPollSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = SchoolPollSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  readonly url: string;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private sessionId: string | null = null;
  private closed = false;
  private recvLoop = 0;

  constructor(
    private readonly pollBase: string,
    private readonly channel: SchoolPollChannel,
  ) {
    this.url = `${pollBase}/api/poll/*#${channel}`;
    void this.open();
  }

  private async open() {
    try {
      const res = await fetch(`${this.pollBase}/api/poll/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: this.channel,
          platform: clientPlatform(),
        }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`poll open ${res.status}`);
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("poll open missing id");
      if (this.closed) {
        void fetch(`${this.pollBase}/api/poll/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: data.id }),
          cache: "no-store",
        });
        return;
      }
      this.sessionId = data.id;
      this.readyState = SchoolPollSocket.OPEN;
      this.onopen?.(new Event("open"));
      this.pump();
    } catch (err) {
      console.warn("[school-poll] open failed", err);
      this.failClose();
    }
  }

  private pump() {
    const gen = ++this.recvLoop;
    void (async () => {
      while (!this.closed && this.sessionId && gen === this.recvLoop) {
        try {
          const ctrl = new AbortController();
          const timer = window.setTimeout(
            () => ctrl.abort(),
            DEFAULT_WAIT_MS + 5_000,
          );
          const res = await fetch(`${this.pollBase}/api/poll/recv`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: this.sessionId }),
            cache: "no-store",
            signal: ctrl.signal,
          });
          window.clearTimeout(timer);
          if (!res.ok) throw new Error(`poll recv ${res.status}`);
          const data = (await res.json()) as { messages?: string[] };
          for (const b64 of data.messages ?? []) {
            if (this.closed) return;
            const buf = bufferFromB64(b64);
            this.onmessage?.(
              new MessageEvent("message", { data: buf }),
            );
          }
        } catch (err) {
          if (this.closed) return;
          console.warn("[school-poll] recv error", err);
          this.failClose();
          return;
        }
      }
    })();
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== SchoolPollSocket.OPEN || !this.sessionId) return;
    let b64: string;
    if (typeof data === "string") {
      b64 = btoa(data);
    } else if (data instanceof ArrayBuffer) {
      b64 = b64FromBuffer(data);
    } else if (ArrayBuffer.isView(data)) {
      b64 = b64FromBuffer(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    } else {
      console.warn("[school-poll] unsupported send type");
      return;
    }
    void fetch(`${this.pollBase}/api/poll/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: this.sessionId, data: b64 }),
      cache: "no-store",
    }).catch((err) => console.warn("[school-poll] send failed", err));
  }

  close(_code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = SchoolPollSocket.CLOSING;
    const id = this.sessionId;
    this.sessionId = null;
    if (id) {
      void fetch(`${this.pollBase}/api/poll/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
        cache: "no-store",
      });
    }
    this.readyState = SchoolPollSocket.CLOSED;
    this.onclose?.(
      new CloseEvent("close", { code: 1000, reason: "normal", wasClean: true }),
    );
  }

  private failClose() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = SchoolPollSocket.CLOSED;
    this.onerror?.(new Event("error"));
    this.onclose?.(
      new CloseEvent("close", {
        code: 1006,
        reason: "poll_failed",
        wasClean: false,
      }),
    );
  }
}
