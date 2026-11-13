import express from "express";
import { createServer } from "node:http";
import { installMatchmaking } from "./matchmaking.mjs";
import { createStatistics } from "./statistics.mjs";
import rateLimit from "express-rate-limit";
import { generateKeyPairSync, randomUUID, createPublicKey, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SignJWT, jwtVerify, exportJWK } from "jose";

// A self-contained guest-session issuer. The signing key stays on this host;
// only short-lived access tokens are sent to JavaScript.
const issuer = process.env.STANDALONE_API_ORIGIN;
const audience = process.env.DOMAIN;
if (!issuer || !audience) throw new Error("STANDALONE_API_ORIGIN and DOMAIN are required");
const keyPath = process.env.STANDALONE_KEY_PATH ?? "standalone-data/key.pem";
mkdirSync(keyPath.slice(0, keyPath.lastIndexOf("/")) || ".", { recursive: true, mode: 0o700 });
let privatePem;
try { privatePem = readFileSync(keyPath, "utf8"); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  const { privateKey } = generateKeyPairSync("ed25519");
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(keyPath, privatePem, { mode: 0o600, flag: "wx" });
}
const { createPrivateKey } = await import("node:crypto");
const privateKey = createPrivateKey(privatePem);
const publicKey = createPublicKey(privateKey);
const jwk = { ...(await exportJWK(publicKey)), alg: "EdDSA", use: "sig" };
const app = express();
app.set("trust proxy", "loopback");
const internalKey = process.env.API_KEY;
function isInternal(req) {
  const provided = req.headers["x-api-key"];
  if (!internalKey || typeof provided !== "string") return false;
  const a = Buffer.from(internalKey), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Check the private ingestion credential before buffering a potentially large record.
app.use("/game/:id", (req, res, next) => {
  if (req.method === "POST" && !isInternal(req)) return res.sendStatus(403);
  next();
});
app.use((req, res, next) => express.json({
  limit: req.method === "POST" && /^\/game\//.test(req.path) ? "40mb" : "1mb",
})(req, res, next));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false }));
const secure = process.env.COOKIE_SECURE !== "false";
const cookieOptions = { httpOnly: true, secure, sameSite: "lax", path: "/front/backend/auth", maxAge: 90 * 86400_000 };
function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map(x => x.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x.length === 2));
}
function permittedOrigin(req) {
  return !req.headers.origin || req.headers.origin === new URL(issuer).origin;
}
function sign(sub, type, ttl) {
  return new SignJWT({ typ: type, provider: "guest" }).setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(issuer).setAudience(audience).setSubject(sub).setJti(randomUUID())
    .setIssuedAt().setExpirationTime(ttl).sign(privateKey);
}
async function verifyAccess(value) {
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, publicKey, { issuer, audience, algorithms: ["EdDSA"] });
    return payload.typ === "access" && typeof payload.sub === "string" ? payload : null;
  } catch { return null; }
}
async function token(req) {
  return verifyAccess(req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]);
}
const publicIdFor = sub => createHmac("sha256", privatePem).update("public-id:" + sub).digest("base64url").slice(0, 22);
app.get("/.well-known/jwks.json", (_req, res) => res.json({ keys: [jwk] }));
app.post("/auth/refresh", async (req, res) => {
  if (!permittedOrigin(req)) return res.sendStatus(403);
  let sub;
  try {
    const old = cookies(req).front_session;
    if (old) {
      const { payload } = await jwtVerify(old, publicKey, { issuer, audience, algorithms: ["EdDSA"] });
      if (payload.typ === "refresh" && typeof payload.sub === "string") sub = payload.sub;
    }
  } catch { /* issue a fresh guest session */ }
  sub ??= Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64url");
  const [jwt, refresh] = await Promise.all([sign(sub, "access", "1h"), sign(sub, "refresh", "90d")]);
  res.set("Cache-Control", "no-store").cookie("front_session", refresh, cookieOptions).json({ jwt, expiresIn: 3600 });
});
app.post("/auth/logout", (req, res) => {
  if (!permittedOrigin(req)) return res.sendStatus(403);
  const { maxAge: _maxAge, ...clearOptions } = cookieOptions;
  res.clearCookie("front_session", clearOptions).sendStatus(204);
});
app.get("/users/@me", async (req, res) => {
  const claims = await token(req);
  if (!claims) return res.sendStatus(401);
  res.set("Cache-Control", "no-store").json({ user: {}, player: {
    publicId: publicIdFor(claims.sub), adfree: true, canCreatePublicLobbies: true,
    achievements: { singleplayerMap: [], player: [] }, friends: [], subscription: null,
  }});
});
app.get("/cosmetics.json", (_req, res) => res.json({ patterns: {}, flags: {} }));
app.get("/reserved_clan_tags", (_req, res) => res.json([]));
app.get("/map_weights", (_req, res) => res.json({ maps: {} }));
app.post("/custom_tribes", (_req, res) => res.json({ tribes: [] }));
app.get("/cluster.json", (_req, res) => res.sendStatus(404));
const gamesDir = process.env.STANDALONE_GAMES_DIR ?? "standalone-data/games";
mkdirSync(gamesDir, { recursive: true, mode: 0o700 });
const stats = createStatistics(gamesDir, publicIdFor);
const validGameId = id => /^[A-Za-z0-9]{8,10}$/.test(id);
app.post("/game/:id", async (req, res) => {
  const id = req.params.id, record = req.body;
  if (!validGameId(id) || !record || record.info?.gameID !== id ||
      !Array.isArray(record.info?.players) || !Array.isArray(record.turns) ||
      record.version !== "v0.0.2" || typeof record.gitCommit !== "string") return res.sendStatus(400);
  for (const player of record.info.players) {
    if (!player || typeof player !== "object" || Array.isArray(player)) return res.sendStatus(400);
  }
  try { return res.sendStatus(stats.archive(id, record) ? 201 : 409); }
  catch (error) { console.error("Failed to store a game record", error.code); return res.sendStatus(500); }
});
app.get("/game/:id", async (req, res) => {
  if (!validGameId(req.params.id)) return res.sendStatus(404);
  try {
    const record = stats.replay(req.params.id) ?? await readFile(join(gamesDir, `${req.params.id}.json`));
    res.type("application/json").set("Cache-Control", "public, max-age=300").send(record);
  } catch (error) {
    if (error.code === "ENOENT") res.sendStatus(404);
    else { console.error("Failed to read a game record", error.code); res.sendStatus(500); }
  }
});
app.get("/public/player/:id", (req, res) => {
  const profile = stats.profile(req.params.id);
  return profile ? res.json(profile) : res.sendStatus(404);
});
app.get("/player/:id", async (req, res) => {
  if (!await token(req)) return res.sendStatus(401);
  const profile = stats.profile(req.params.id);
  return profile ? res.json(profile) : res.sendStatus(404);
});
app.get("/leaderboard/ranked", (_req, res) => res.json(stats.leaderboard()));
app.get("/health", (_req, res) => res.json({ ok: true }));
const server = createServer(app);
installMatchmaking({ app, server, verifyAccess, publicIdFor, isInternal, allowedOrigin: new URL(issuer).origin });
server.listen(Number(process.env.STANDALONE_API_PORT ?? 13802), "127.0.0.1", () => console.log("Standalone API listening on loopback"));
