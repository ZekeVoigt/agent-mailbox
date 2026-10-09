// verifyClerk against a key this test makes (node test/auth.test.mjs): every forgery a live e2e
// cannot produce -- another algorithm, a bad signature, another issuer, expired, minted for
// another site, an inactive session -- and the key set fetched at most once a minute.
import assert from "node:assert/strict";
import {verifyClerk, CLERK_FAPI} from "../src/auth.js";

const {publicKey, privateKey} = await crypto.subtle.generateKey({name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"}, true, ["sign", "verify"]);
const jwk = {...await crypto.subtle.exportKey("jwk", publicKey), kid: "k1", alg: "RS256", use: "sig"};
let fetches = 0;
globalThis.fetch = async url => {
  assert.equal(String(url), `${CLERK_FAPI}/.well-known/jwks.json`);
  fetches++;
  return new Response(JSON.stringify({keys: [jwk]}));
};
const b64u = b => Buffer.from(b).toString("base64url");
const SITE = "https://agents.example";
async function token(claims = {}, head = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({alg: "RS256", kid: "k1", typ: "JWT", ...head}));
  const p = b64u(JSON.stringify({iss: CLERK_FAPI, sub: "user_abc", exp: now + 60, nbf: now - 10,
    iat: now, sid: "sess_1", sts: "active", azp: SITE, ...claims}));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const other = (await crypto.subtle.generateKey({name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"}, true, ["sign"])).privateKey;
const cases = [
  ["a token minted for this site", await token(), "user_abc"],
  ["a backend-minted token (no azp)", await token({azp: undefined}), "user_abc"],
  ["minted for another site sharing the instance", await token({azp: "https://other.example"}), null],
  ["azp of a sibling subdomain", await token({azp: "https://x.agents.example"}), null],
  ["another issuer", await token({iss: "https://evil.clerk.accounts.dev"}), null],
  ["expired", await token({exp: Math.floor(Date.now() / 1000) - 60}), null],
  ["not yet valid", await token({nbf: Math.floor(Date.now() / 1000) + 600}), null],
  ["an ended session", await token({sts: "ended"}), null],
  ["not a user", await token({sub: "org_abc"}), null],
  ["signed by another key", await token({}, {}, other), null],
  ["alg none", (await token({}, {alg: "none"})).split(".").slice(0, 2).join(".") + ".", null],
  ["alg HS256", await token({}, {alg: "HS256"}), null],
  ["claims swapped after signing", (() => {})(), null],
  ["garbage", "x.y.z", null],
  ["empty", "", null],
];
const t = await token();
const [h, , sig] = t.split(".");
cases[12][1] = `${h}.${b64u(JSON.stringify({iss: CLERK_FAPI, sub: "user_evil", exp: 9e9, azp: SITE}))}.${sig}`;
let failed = 0;
for (const [what, tok, want] of cases) {
  const got = await verifyClerk(tok, SITE);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok ? "" : ` (got ${got})`}`);
}
const before = fetches;
for (let i = 0; i < 50; i++) await verifyClerk(await token({}, {kid: "unknown-" + i}), SITE);
const flood = fetches - before;
console.log(`${flood <= 1 ? "PASS" : "FAIL"} 50 tokens naming unknown keys fetch the key set at most once a minute (${flood})`);
if (flood > 1) failed++;
// Clerk rotates its key: a minute on, a token under the new key is verified (one fetch), and the
// flood still costs nothing more
const realNow = Date.now, t0 = realNow();
Date.now = () => t0 + 61e3;
const rotated = await crypto.subtle.generateKey({name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"}, true, ["sign", "verify"]);
const jwk2 = {...await crypto.subtle.exportKey("jwk", rotated.publicKey), kid: "k2", alg: "RS256", use: "sig"};
globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({keys: [jwk, jwk2]})); };
const f0 = fetches;
const got2 = await verifyClerk(await token({}, {kid: "k2"}, rotated.privateKey), SITE);
for (let i = 0; i < 50; i++) await verifyClerk(await token({}, {kid: "bogus-" + i}), SITE);
const rot = got2 === "user_abc" && fetches - f0 === 1;
console.log(`${rot ? "PASS" : "FAIL"} a rotated key is picked up a minute on, with one fetch for it and the flood (${fetches - f0})`);
if (!rot) failed++;
Date.now = realNow;
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
