// Run against the isolated preview: npx tsx standalone/test/multiplayer.test.ts
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { encodeClientMessage, decodeServerMessage, createGameWireContext } from "@openfront/shared/ZbinWire";
const base = process.env.FRONT_TEST_BASE ?? "http://localhost:13994/front";
const commit = "2f0252dda9c4330b78ad3012d8570a7e929b071e";
async function guest() {
  const r = await fetch(`${base}/backend/auth/refresh`, { method: "POST" });
  assert.equal(r.status, 200);
  return (await r.json()).jwt as string;
}
const hostToken = await guest(), playerToken = await guest();
const create = await fetch(`${base}/api/create_game`, { method: "POST", headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" }, body: "{}" });
assert.equal(create.status, 200);
const game = await create.json() as { gameID: string };
function connect(token: string, username: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/w0`);
    const timer = setTimeout(() => reject(new Error(`${username} join timeout`)), 10000);
    ws.on("error", reject);
    ws.on("open", () => ws.send(encodeClientMessage({ type: "join", gameID: game.gameID, token, username, clanTag: null, turnstileToken: null, gitCommit: commit }, undefined)));
    ws.on("message", data => {
      const msg = decodeServerMessage(new Uint8Array(data as Buffer), undefined);
      if (msg.type === "lobby_info") { clearTimeout(timer); resolve(ws); }
      if (msg.type === "error") reject(new Error(`${username}: ${msg.error}`));
    });
    ws.on("close", (code, reason) => { if (timer) reject(new Error(`${username} closed ${code}: ${reason}`)); });
  });
}
const host = await connect(hostToken, "HostTest");
const player = await connect(playerToken, "PlayerTest");
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("two players were not broadcast")), 5000);
  host.on("message", data => {
    const msg = decodeServerMessage(new Uint8Array(data as Buffer), undefined);
    if (msg.type === "lobby_info" && (msg.lobby.clients?.length ?? 0) >= 2) {
      clearTimeout(timer); resolve();
    }
  });
});
console.log("Two independent signed guest sessions joined the same lobby.");
host.removeAllListeners("message");
player.removeAllListeners("message");
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("game did not start")), 20000);
  let context: ReturnType<typeof createGameWireContext> | undefined;
  host.on("message", data => {
    const msg = decodeServerMessage(new Uint8Array(data as Buffer), context);
    if (msg.type === "start") context = createGameWireContext(msg.gameStartInfo.players);
    if (msg.type === "turn") { clearTimeout(timer); resolve(); }
    if (msg.type === "error") reject(new Error(`start: ${msg.error}`));
  });
  host.send(encodeClientMessage({ type: "intent", intent: { type: "toggle_game_start_timer" } }, undefined));
});
console.log("The host started the multiplayer match and received a game turn.");
host.close(); player.close();
