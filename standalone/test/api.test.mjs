import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, jwtVerify, importJWK } from "jose";

const port = 13995;
const origin = `http://localhost:${port}`;
const issuer = `${origin}/front/backend`;
let server, dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "front-api-test-"));
  server = spawn(process.execPath, ["standalone/api.mjs"], { env: {
    ...process.env, STANDALONE_API_PORT: String(port), STANDALONE_API_ORIGIN: issuer,
    STANDALONE_KEY_PATH: join(dir, "key.pem"), DOMAIN: "localhost", COOKIE_SECURE: "false",
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
