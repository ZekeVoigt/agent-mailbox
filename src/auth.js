// Signing in: Clerk proves who the person is once; then this site keeps its own session.
//
// The page runs Clerk's sign-in, then POSTs Clerk's session token to /session. Here it is
// checked -- RS256 under the key Clerk publishes for this instance (its JWKS), not expired, from
// this instance (`iss`) -- and the browser gets this site's own cookie: `cx`, the Clerk user id
// and an expiry, HMAC-signed with SESSION_KEY, HttpOnly, 30 days. So a form post never meets an
// expired 60-second Clerk token.

export const CLERK_FAPI = "https://included-rattler-20.clerk.accounts.dev";
export const CLERK_PK = "pk_test_aW5jbHVkZWQtcmF0dGxlci0yMC5jbGVyay5hY2NvdW50cy5kZXYk";
const COOKIE = "cx", DAYS = 30;

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") +
  "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);

let jwks = null, jwksAt = 0;
async function keyFor(kid) {
  if (!jwks || Date.now() - jwksAt > 3600e3 || !jwks.find(k => k.kid === kid)) {
    jwks = (await (await fetch(`${CLERK_FAPI}/.well-known/jwks.json`)).json()).keys;
    jwksAt = Date.now();
  }
  const jwk = jwks.find(k => k.kid === kid);
  return jwk && crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"},
    false, ["verify"]);
}

/** The Clerk user id a session token proves, or null. */
export async function verifyClerk(token) {
  try {
    const [h, p, sig] = String(token || "").split(".");
    const head = JSON.parse(new TextDecoder().decode(unb64u(h)));
    const body = JSON.parse(new TextDecoder().decode(unb64u(p)));
    if (head.alg !== "RS256") return null;
    const key = await keyFor(head.kid);
    if (!key || !await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(sig), utf8(`${h}.${p}`)))
      return null;
    const now = Date.now() / 1000;
    if (body.iss !== CLERK_FAPI || !(body.exp > now - 5) || (body.nbf && body.nbf > now + 5))
      return null;
    return typeof body.sub === "string" && body.sub.startsWith("user_") ? body.sub : null;
  } catch { return null; }
}

/** The person's name and email from Clerk's Backend API (for the first visit's form). */
export async function clerkUser(env, id) {
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(id)}`,
      {headers: {authorization: `Bearer ${env.CLERK_SECRET_KEY}`}});
    if (!r.ok) return {};
    const u = await r.json();
    const email = (u.email_addresses || []).find(e => e.id === u.primary_email_address_id);
    return {name: [u.first_name, u.last_name].filter(Boolean).join(" "),
            email: email ? email.email_address : "", username: u.username || ""};
  } catch { return {}; }
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", utf8(env.SESSION_KEY),
    {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, utf8(data)));
}

export async function sessionCookie(env, userId) {
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400, data = `${userId}.${exp}`;
  return `${COOKIE}=${data}.${await hmac(env, data)}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${DAYS * 86400}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The Clerk user id this browser is signed in as, or null. */
export async function sessionOf(env, req) {
  const m = /(?:^|;\s*)cx=([^;]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  const [user, exp, sig] = parts;
  if (!(Number(exp) > Date.now() / 1000)) return null;
  const want = await hmac(env, `${user}.${exp}`);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? user : null;
}
