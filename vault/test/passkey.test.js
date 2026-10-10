// src/passkey.js with the keys real devices make: ES256 (P-256), as Apple's and Google's passkeys do.
// The e2e's software passkey is RS256; this covers the other path, DER signatures included.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash, webcrypto} from "node:crypto";
import {verifyCreate, verifyGet, b64u, unb64u, cbor} from "../../src/passkey.js";

const origin = "https://agents.ai-andromeda.com", rpId = "agents.ai-andromeda.com";
const sha = b => new Uint8Array(createHash("sha256").update(b).digest());

function cborEnc(x) {               // just what a registration needs
  const head = (m, n) => n < 24 ? [m << 5 | n] : n < 256 ? [m << 5 | 24, n] : [m << 5 | 25, n >> 8, n & 255];
  if (typeof x === "number") return Uint8Array.from(x >= 0 ? head(0, x) : head(1, -1 - x));
  if (x instanceof Uint8Array) return Uint8Array.from([...head(2, x.length), ...x]);
  if (typeof x === "string") { const b = new TextEncoder().encode(x); return Uint8Array.from([...head(3, b.length), ...b]); }
  if (x instanceof Map) return Uint8Array.from([...head(5, x.size), ...[...x].flatMap(([k, v]) => [...cborEnc(k), ...cborEnc(v)])]);
  throw new Error("cborEnc");
}
// raw r|s -> DER, as authenticators sign
function der(raw) {
  const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i);
    return b[0] & 128 ? [2, b.length + 1, 0, ...b] : [2, b.length, ...b]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

async function device() {
  const kp = await webcrypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const id = webcrypto.getRandomValues(new Uint8Array(32));
  let count = 0;
  const client = (type, challenge, o = origin) => new TextEncoder().encode(JSON.stringify({type, challenge, origin: o}));
  return {
    create(challenge, o) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
      const auth = Uint8Array.from([...sha(rpId), 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, 32, ...id, ...cborEnc(cose)]);
      const att = cborEnc(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", auth]]));
      return {id: b64u(id), clientDataJSON: b64u(client("webauthn.create", challenge, o)), attestationObject: b64u(att)};
    },
    async get(challenge, {rp = rpId, bump = 1} = {}) {
      count += bump;
      const cd = client("webauthn.get", challenge);
      const auth = Uint8Array.from([...sha(rp), 0x05, 0, 0, 0, count]);
      const raw = new Uint8Array(await webcrypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, kp.privateKey,
        Uint8Array.from([...auth, ...sha(cd)])));
      return {id: b64u(id), clientDataJSON: b64u(cd), authenticatorData: b64u(auth), signature: b64u(der(raw))};
    },
  };
}

test("an ES256 passkey registers and unlocks; a changed byte, another site, a stale counter do not", async () => {
  const d = await device();
  const stored = await verifyCreate(d.create("c1"), {challenge: "c1", origin, rpId});
  assert.equal(stored.alg, -7);
  assert.equal(stored.jwk.crv, "P-256");
  const count = await verifyGet(await d.get("c2"), stored, {challenge: "c2", origin, rpId});
  assert.equal(count, 1);
  stored.count = count;
  const a = await d.get("c3");
  const bad = {...a, signature: b64u(unb64u(a.signature).map((x, i, s) => i === s.length - 1 ? x ^ 1 : x))};
  await assert.rejects(verifyGet(bad, stored, {challenge: "c3", origin, rpId}));
  await assert.rejects(verifyGet(a, stored, {challenge: "another", origin, rpId}), /challenge/);
  await assert.rejects(verifyGet(await d.get("c4", {rp: "evil.example"}), stored, {challenge: "c4", origin, rpId}), /another site/);
  await assert.rejects(verifyGet(await d.get("c5", {bump: -2}), {...stored, count: 5}, {challenge: "c5", origin, rpId}), /cloned/);
  await assert.rejects(verifyCreate(d.create("c6", "https://evil.example"), {challenge: "c6", origin, rpId}), /another site/);
});

test("the CBOR reader reads what a registration holds", () => {
  const m = cbor(cborEnc(new Map([["fmt", "none"], [3, -7], [-1, 1]])))[0];
  assert.equal(m.get("fmt"), "none");
  assert.equal(m.get(3), -7);
  assert.equal(m.get(-1), 1);
});
