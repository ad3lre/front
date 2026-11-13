import { WebSocket, WebSocketServer } from "ws";

// A single-server queue. A worker offers a fresh game id via its authenticated
// check-in; only then are waiting players assigned to it. Queue state is
// ephemeral, and a disconnect removes the player immediately.
export function installMatchmaking({ app, server, verifyAccess, publicIdFor, isInternal, allowedOrigin }) {
  const sizes = { "1v1": 2, "2v2": 4 };
  const queued = new Map(); // subject -> { socket, mode, version, publicId }
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const count = mode => [...queued.values()].filter(p => p.mode === mode).length;
  function broadcast(mode) {
    const message = JSON.stringify({ type: "queue-size", count: count(mode) });
    for (const p of queued.values()) if (p.mode === mode && p.socket.readyState === WebSocket.OPEN) p.socket.send(message);
  }
  const heartbeat = setInterval(() => { for (const mode of Object.keys(sizes)) broadcast(mode); }, 8000);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/matchmaking/join" || !sizes[url.searchParams.get("mode")] ||
        (req.headers.origin && req.headers.origin !== allowedOrigin) || sockets.clients.size >= 2000) {
      socket.destroy(); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit("connection", ws, req, url));
  });
  sockets.on("connection", (ws, _req, url) => {
    const mode = url.searchParams.get("mode");
    const version = url.searchParams.get("version") ?? "";
    let subject = null, authenticating = false;
    const deadline = setTimeout(() => ws.close(1008, "Invalid session"), 10000);
    ws.on("error", () => {});
    ws.on("message", async raw => {
      if (subject || authenticating) return;
      authenticating = true;
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch { ws.close(1008, "Invalid session"); return; }
      const claims = payload?.type === "join" && typeof payload.jwt === "string" ? await verifyAccess(payload.jwt) : null;
      if (!claims || ws.readyState !== WebSocket.OPEN) { ws.close(1008, "Invalid session"); return; }
      clearTimeout(deadline);
      subject = claims.sub;
      const existing = queued.get(subject);
      if (existing) { queued.delete(subject); existing.socket.close(1000, "Replaced by newer connection"); broadcast(existing.mode); }
      queued.set(subject, { socket: ws, mode, version, publicId: publicIdFor(subject) });
      broadcast(mode);
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      if (subject && queued.get(subject)?.socket === ws) { queued.delete(subject); broadcast(mode); }
    });
  });
  app.post("/matchmaking/checkin", (req, res) => {
    if (!isInternal(req)) return res.sendStatus(403);
    const { mode, gameId, version = "" } = req.body ?? {};
    if (mode === "clanwars") return res.json({ assignment: null });
    if (!sizes[mode] || typeof gameId !== "string" || !/^[A-Za-z0-9]{8,10}$/.test(gameId) || typeof version !== "string") return res.status(400).json({ error: "Invalid check-in" });
    const players = [...queued.entries()].filter(([, p]) => p.mode === mode && p.version === version && p.socket.readyState === WebSocket.OPEN).slice(0, sizes[mode]);
    if (players.length < sizes[mode]) return res.json({ assignment: null });
    for (const [subject] of players) queued.delete(subject);
    const ids = players.map(([, p]) => p.publicId);
    const half = ids.length / 2;
    res.json({ assignment: { players: ids, teams: [ids.slice(0, half), ids.slice(half)] } });
    const notice = JSON.stringify({ type: "match-assignment", gameId });
    for (const [, p] of players) if (p.socket.readyState === WebSocket.OPEN) p.socket.send(notice);
    broadcast(mode);
  });
}
