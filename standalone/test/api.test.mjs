import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, jwtVerify, importJWK } from "jose";
import { WebSocket } from "ws";
import { once } from "node:events";

const port = 13995;
const origin = `http://localhost:${port}`;
const issuer = `${origin}/front/backend`;
let server, dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "front-api-test-"));
  server = spawn(process.execPath, ["standalone/api.mjs"], { env: {
    ...process.env, STANDALONE_API_PORT: String(port), STANDALONE_API_ORIGIN: issuer,
    STANDALONE_KEY_PATH: join(dir, "key.pem"), STANDALONE_GAMES_DIR: join(dir, "games"),
    API_KEY: "test-internal-key", DOMAIN: "localhost", COOKIE_SECURE: "false",
  }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`API exited ${server.exitCode}`);
    try { if ((await fetch(`${origin}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("API did not start");
});
after(async () => { server?.kill(); await rm(dir, { recursive: true, force: true }); });

test("guest sessions refresh consistently and authenticate profile", async () => {
  const initial = await fetch(`${origin}/auth/refresh`, { method: "POST", headers: { origin } });
  assert.equal(initial.status, 200);
  const cookie = initial.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const first = await initial.json();
  const renewed = await fetch(`${origin}/auth/refresh`, { method: "POST", headers: { origin, cookie: cookie.split(";")[0] } });
  const second = await renewed.json();
  assert.equal(decodeJwt(first.jwt).sub, decodeJwt(second.jwt).sub);
  const jwks = await (await fetch(`${origin}/.well-known/jwks.json`)).json();
  const key = await importJWK(jwks.keys[0], "EdDSA");
  const verified = await jwtVerify(second.jwt, key, { issuer, audience: "localhost" });
  assert.equal(verified.payload.typ, "access");
  const profile = await fetch(`${origin}/users/@me`, { headers: { authorization: `Bearer ${second.jwt}` } });
  assert.equal(profile.status, 200);
  const publicId = (await profile.json()).player.publicId;
  assert.notEqual(publicId, verified.payload.sub);
  assert.match(publicId, /^[A-Za-z0-9_-]{22}$/);
  const again = await fetch(`${origin}/users/@me`, { headers: { authorization: `Bearer ${first.jwt}` } });
  assert.equal((await again.json()).player.publicId, publicId);
});

test("untrusted origins and invalid or refresh tokens cannot read profiles", async () => {
  const denied = await fetch(`${origin}/auth/refresh`, { method: "POST", headers: { origin: "https://elsewhere.invalid" } });
  assert.equal(denied.status, 403);
  const fresh = await fetch(`${origin}/auth/refresh`, { method: "POST", headers: { origin } });
  const refreshToken = fresh.headers.get("set-cookie").split(";")[0].split("=")[1];
  for (const value of ["garbage", refreshToken]) {
    const response = await fetch(`${origin}/users/@me`, { headers: { authorization: `Bearer ${value}` } });
    assert.equal(response.status, 401);
  }
});


test("only the game server can archive; replays omit private identities and reports", async () => {
  const fixture = JSON.parse(await readFile("records/demoGame1.json", "utf8"));
  fixture.info.players[0].persistentID = "550e8400-e29b-41d4-a716-446655440000";
  fixture.info.reports = [{ private: "not for the replay" }];
  const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture) };
  assert.equal((await fetch(`${origin}/game/demoGame1`, options)).status, 403);
  options.headers["x-api-key"] = "test-internal-key";
  assert.equal((await fetch(`${origin}/game/demoGame1`, options)).status, 201);
  assert.equal((await fetch(`${origin}/game/demoGame1`, options)).status, 409);
  const replay = await (await fetch(`${origin}/game/demoGame1`)).json();
  assert.equal(replay.info.players[0].persistentID, null);
  assert.equal(replay.info.reports, undefined);
  assert.deepEqual(replay.turns, fixture.turns);
  assert.equal((await fetch(`${origin}/game/unknown01`)).status, 404);
});


test("matchmaking only assigns compatible authenticated players through a trusted worker", async () => {
  const version = "a".repeat(40);
  async function client() {
    const auth = await (await fetch(`${origin}/auth/refresh`, { method: "POST" })).json();
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/matchmaking/join?mode=1v1&version=${version}`);
    const messages = [];
    ws.on("message", data => messages.push(JSON.parse(data)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "join", jwt: auth.jwt }));
    const me = await (await fetch(`${origin}/users/@me`, { headers: { authorization: `Bearer ${auth.jwt}` } })).json();
    return { ws, messages, publicId: me.player.publicId };
  }
  async function until(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error("timed out waiting for queue state");
  }
  const a = await client(), b = await client();
  try {
    await until(() => a.messages.some(m => m.type === "queue-size" && m.count === 2));
    const request = (key, ver) => fetch(`${origin}/matchmaking/checkin`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ gameId: "a123456789", mode: "1v1", version: ver }),
    });
    assert.equal((await request("wrong", version)).status, 403);
    assert.equal((await (await request("test-internal-key", "b".repeat(40))).json()).assignment, null);
    const result = await (await request("test-internal-key", version)).json();
    assert.deepEqual(result.assignment.players, [a.publicId, b.publicId]);
    assert.deepEqual(result.assignment.teams, [[a.publicId], [b.publicId]]);
    await until(() => [a, b].every(c => c.messages.some(m => m.type === "match-assignment" && m.gameId === "a123456789")));
    assert.equal((await (await request("test-internal-key", version)).json()).assignment, null);
  } finally { a.ws.close(); b.ws.close(); }
});

test("confirmed ranked results persist once and appear on profiles and ladders", async () => {
  const jwt = (await (await fetch(`${origin}/auth/refresh`, { method: "POST" })).json()).jwt;
  const sub = decodeJwt(jwt).sub;
  const bytes = Buffer.from(sub, "base64url").toString("hex");
  const uuid = `${bytes.slice(0,8)}-${bytes.slice(8,12)}-${bytes.slice(12,16)}-${bytes.slice(16,20)}-${bytes.slice(20)}`;
  const me = await (await fetch(`${origin}/users/@me`, { headers: { authorization: `Bearer ${jwt}` } })).json();
  const fixture = JSON.parse(await readFile("records/demoGame1.json", "utf8"));
  fixture.info.gameID = "a765432109";
  fixture.info.players[0].persistentID = uuid;
  fixture.info.winner = ["player", fixture.info.players[0].clientID];
  fixture.info.statsAgreed = true;
  fixture.info.config.rankedType = "1v1";
  fixture.info.config.gameType = "Public";
  fixture.info.config.gameMode = "Free For All";
  fixture.info.config.difficulty = "Medium";
  const options = { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-internal-key" }, body: JSON.stringify(fixture) };
  assert.equal((await fetch(`${origin}/game/a765432109`, options)).status, 201);
  assert.equal((await fetch(`${origin}/game/a765432109`, options)).status, 409);
  const profile = await (await fetch(`${origin}/public/player/${me.player.publicId}`)).json();
  assert.equal(profile.stats.Ranked["1v1"].wins, "1");
  assert.equal(profile.stats.Public["Free For All"].Medium.total, "1");
  const board = await (await fetch(`${origin}/leaderboard/ranked`)).json();
  assert.equal(board["1v1"].find(p => p.public_id === me.player.publicId).wins, 1);
  const replay = await (await fetch(`${origin}/game/a765432109`)).json();
  assert.equal(replay.info.players[0].persistentID, null);
});
