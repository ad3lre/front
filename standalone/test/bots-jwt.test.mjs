import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt } from "jose";
import { SignJWT, exportJWK, jwtVerify } from "jose";
import { generateKeyPairSync, randomUUID, createPublicKey } from "node:crypto";

// Mirrors standalone/api.mjs mintBotJwt claim shape without booting the server.
test("bot access tokens carry bot:true for the worker to stamp isBot", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey);
  const issuer = "https://example.test/front/backend";
  const audience = "example.test";
  const sub = Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString(
    "base64url",
  );
  const jwt = await new SignJWT({
    typ: "access",
    provider: "guest",
    bot: true,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  const raw = decodeJwt(jwt);
  assert.equal(raw.bot, true);
  assert.equal(raw.typ, "access");

  const verified = await jwtVerify(jwt, publicKey, {
    issuer,
    audience,
    algorithms: ["EdDSA"],
  });
  assert.equal(verified.payload.bot, true);
  assert.equal(typeof verified.payload.sub, "string");

  const jwk = await exportJWK(publicKey);
  assert.equal(jwk.kty, "OKP");
});
