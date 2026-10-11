// Passkeys (WebAuthn), checked here -- inside the sealed Vault. Clerk proves who someone is; once a
// person has a passkey, Clerk alone opens nothing: every session must also be unlocked by one of
// their passkeys (or a one-time recovery code). So a Clerk session minted by whoever holds Clerk's
// secret key -- the operator included -- cannot read a dashboard, add an agent or answer a request.
// No dependencies: a small CBOR reader, COSE keys as JWKs, WebCrypto for the signatures.

const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-")
  .replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")
  .padEnd(Math.ceil(String(s).length / 4) * 4, "=")), c => c.charCodeAt(0));
const sha256 = async b => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// -- CBOR, the subset WebAuthn uses: unsigned/negative ints, byte and text strings, arrays, maps,
// and simple values. Returns [value, next offset]
export function cbor(b, i = 0) {
  const ib = b[i++], major = ib >> 5, minor = ib & 31;
  let n = minor;
  if (minor === 24) n = b[i++];
  else if (minor === 25) { n = (b[i] << 8) | b[i + 1]; i += 2; }
  else if (minor === 26) { n = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; i += 4; }
  else if (minor > 26) throw new Error("cbor: unsupported length");
  if (major === 0) return [n, i];
  if (major === 1) return [-1 - n, i];
  if (major === 2) return [b.slice(i, i + n), i + n];
  if (major === 3) return [new TextDecoder().decode(b.slice(i, i + n)), i + n];
  if (major === 4) { const a = []; for (let k = 0; k < n; k++) { let v; [v, i] = cbor(b, i); a.push(v); } return [a, i]; }
  if (major === 5) {
    const m = new Map();
    for (let k = 0; k < n; k++) { let key, v; [key, i] = cbor(b, i); [v, i] = cbor(b, i); m.set(key, v); }
    return [m, i];
  }
  if (major === 7) return [minor === 20 ? false : minor === 21 ? true : null, i];
  throw new Error("cbor: unsupported type");
}

// a COSE public key -> {jwk, alg} for WebCrypto: ES256 (P-256) or RS256
function coseKey(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1)
    return {alg: -7, jwk: {kty: "EC", crv: "P-256", x: b64u(m.get(-2)), y: b64u(m.get(-3)), ext: true}};
  if (kty === 3 && alg === -257) return {alg: -257, jwk: {kty: "RSA", n: b64u(m.get(-1)), e: b64u(m.get(-2)), ext: true}};
  throw new Error("passkey: only ES256 and RS256 keys are accepted");
}

// authenticator data: rpIdHash(32) flags(1) signCount(4) [attested credential data]
function authData(a) {
  if (a.length < 37) throw new Error("passkey: authenticator data too short");
  const flags = a[32], count = ((a[33] << 24) >>> 0) + (a[34] << 16) + (a[35] << 8) + a[36];
  const out = {rpIdHash: a.slice(0, 32), up: !!(flags & 1), uv: !!(flags & 4), count};
  if (flags & 64) {
    const len = (a[53] << 8) | a[54];
    out.credId = a.slice(55, 55 + len);
    out.key = coseKey(cbor(a, 55 + len)[0]);
  }
  return out;
}

function clientData(json, type, challenge, origin) {
  const c = JSON.parse(new TextDecoder().decode(json));
  if (c.type !== type) throw new Error("passkey: wrong ceremony");
  if (c.challenge !== challenge) throw new Error("passkey: wrong or stale challenge");
  if (c.origin !== origin) throw new Error("passkey: made for another site");
  return c;
}

export const newChallenge = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

// the options the browser's navigator.credentials.create/get take (as JSON: binary fields b64url)
export function createOptions(rpId, user, challenge, exclude = []) {
  return {challenge, rp: {id: rpId, name: "The Constellation"},
    user: {id: user.id, name: user.name, displayName: user.name},
    pubKeyCredParams: [{type: "public-key", alg: -7}, {type: "public-key", alg: -257}],
    authenticatorSelection: {residentKey: "preferred", userVerification: "required"},
    excludeCredentials: exclude.map(id => ({type: "public-key", id})), attestation: "none", timeout: 120000};
}
export const getOptions = (rpId, challenge, allow) => ({challenge, rpId, userVerification: "required",
  allowCredentials: allow.map(id => ({type: "public-key", id})), timeout: 120000});

// a registration -> {id, jwk, alg, count} to store
export async function verifyCreate(r, {challenge, origin, rpId}) {
  clientData(unb64u(r.clientDataJSON), "webauthn.create", challenge, origin);
  const att = cbor(unb64u(r.attestationObject))[0];
  const a = authData(att.get("authData"));
  if (!same(a.rpIdHash, await sha256(enc.encode(rpId)))) throw new Error("passkey: made for another site");
  if (!a.up) throw new Error("passkey: no user presence");
  if (!a.uv) throw new Error("passkey: no Face ID, fingerprint or PIN");
  if (!a.credId || !a.key) throw new Error("passkey: no credential in the registration");
  if (b64u(a.credId) !== r.id) throw new Error("passkey: credential id mismatch");
  return {id: r.id, jwk: a.key.jwk, alg: a.key.alg, count: a.count};
}

// DER ECDSA signature -> the raw r|s WebCrypto verifies
function rawSig(der) {
  let i = 2;
  const part = () => { if (der[i++] !== 2) throw new Error("passkey: bad signature"); const n = der[i++];
    let v = der.slice(i, i + n); i += n; while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = part(), s = part(), out = new Uint8Array(64); out.set(r); out.set(s, 32); return out;
}

// an assertion against a stored key -> the new signature counter
export async function verifyGet(r, stored, {challenge, origin, rpId}) {
  const cd = unb64u(r.clientDataJSON);
  clientData(cd, "webauthn.get", challenge, origin);
  const ad = unb64u(r.authenticatorData), a = authData(ad);
  if (!same(a.rpIdHash, await sha256(enc.encode(rpId)))) throw new Error("passkey: made for another site");
  if (!a.up) throw new Error("passkey: no user presence");
  if (!a.uv) throw new Error("passkey: no Face ID, fingerprint or PIN");
  const signed = new Uint8Array(ad.length + 32);
  signed.set(ad); signed.set(await sha256(cd), ad.length);
  const es = stored.alg === -7;
  const key = await crypto.subtle.importKey("jwk", stored.jwk, es ? {name: "ECDSA", namedCurve: "P-256"} :
    {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
  const sig = unb64u(r.signature);
  const ok = await crypto.subtle.verify(es ? {name: "ECDSA", hash: "SHA-256"} : {name: "RSASSA-PKCS1-v1_5"},
    key, es ? rawSig(sig) : sig, signed);
  if (!ok) throw new Error("passkey: the signature does not verify");
  if (a.count && stored.count && a.count <= stored.count) throw new Error("passkey: a cloned authenticator (counter went back)");
  return a.count;
}
