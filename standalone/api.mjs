import express from "express";
import rateLimit from "express-rate-limit";
import { generateKeyPairSync, randomUUID, createPublicKey, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
app.use(express.json({ limit: "1mb" }));
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
async function token(req) {
  const value = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, publicKey, { issuer, audience, algorithms: ["EdDSA"] });
    return payload.typ === "access" && typeof payload.sub === "string" ? payload : null;
  } catch { return null; }
}
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
    publicId: createHmac("sha256", privatePem).update("public-id:" + claims.sub).digest("base64url").slice(0, 22), adfree: true, canCreatePublicLobbies: true,
    achievements: { singleplayerMap: [], player: [] }, friends: [], subscription: null,
  }});
});
app.get("/cosmetics.json", (_req, res) => res.json({ patterns: {}, flags: {} }));
app.get("/reserved_clan_tags", (_req, res) => res.json([]));
app.get("/map_weights", (_req, res) => res.json({ maps: {} }));
app.post("/custom_tribes", (_req, res) => res.json({ tribes: [] }));
app.get("/cluster.json", (_req, res) => res.sendStatus(404));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(Number(process.env.STANDALONE_API_PORT ?? 13802), "127.0.0.1", () => console.log("Standalone API listening on loopback"));
