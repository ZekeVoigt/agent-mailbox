// Signing in: Clerk proves who the person is once; then this site keeps its own session
// (index.js: an opaque cookie whose digest the directory holds, revocable).
//
// The page runs Clerk's sign-in, then POSTs Clerk's session token to /session. Here it is
// checked -- RS256 under the key Clerk publishes for this instance (its JWKS), not expired, from
// this instance (`iss`), and minted for this site (`azp`: a token a browser got on another site
// that shares the Clerk instance names that site, and is refused; a token Clerk's backend mints
// has no `azp`, and only a holder of the secret key can mint one). "Sign out everywhere" and deleting an account also end the person's
// Clerk sessions, so no browser can quietly sign back in.

// the Clerk instance: the development one by default; a deployment of its own sets CLERK_FAPI and
// CLERK_PK (vars) to its production instance, and CLERK_SECRET_KEY (a secret) to that instance's key
export let CLERK_FAPI = "https://included-rattler-20.clerk.accounts.dev";
export let CLERK_PK = "pk_test_aW5jbHVkZWQtcmF0dGxlci0yMC5jbGVyay5hY2NvdW50cy5kZXYk";
export function configureClerk(env) {
  if (env.CLERK_FAPI && env.CLERK_FAPI !== CLERK_FAPI) { CLERK_FAPI = env.CLERK_FAPI; jwks = null; }
  if (env.CLERK_PK) CLERK_PK = env.CLERK_PK;
}

const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") +
  "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);

// fetched at most once a minute: a token naming a key Clerk never published cannot make every
// request fetch the key set again
let jwks = null, jwksAt = 0;
async function keyFor(kid) {
  const age = Date.now() - jwksAt;
  if (!jwks || age > 3600e3 || (!jwks.find(k => k.kid === kid) && age > 60e3)) {
    jwksAt = Date.now();
    jwks = (await (await fetch(`${CLERK_FAPI}/.well-known/jwks.json`)).json()).keys;
  }
  const jwk = jwks.find(k => k.kid === kid);
  return jwk && crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"},
    false, ["verify"]);
}

/** The Clerk user id a session token proves for this site (`origin`), or null. */
export async function verifyClerk(token, origin) {
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
    if (body.azp !== undefined && body.azp !== origin) return null;
    if (body.sts !== undefined && body.sts !== "active") return null;
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
            email: email ? email.email_address : "", username: u.username || "",
            // an e2e account: only Clerk's backend (the secret key) can set public metadata
            test: !!(u.public_metadata && u.public_metadata.test === true)};
  } catch { return {}; }
}

/** Ends every active Clerk session of this user (sign out everywhere). */
export async function revokeClerkSessions(env, id) {
  const auth = {authorization: `Bearer ${env.CLERK_SECRET_KEY}`};
  try {
    const r = await fetch(`https://api.clerk.com/v1/sessions?user_id=${encodeURIComponent(id)}` +
      "&status=active&limit=100", {headers: auth});
    if (!r.ok) return;
    const got = await r.json(), list = Array.isArray(got) ? got : got.data || [];
    for (const x of list)
      await fetch(`https://api.clerk.com/v1/sessions/${encodeURIComponent(x.id)}/revoke`,
        {method: "POST", headers: auth});
  } catch {}
}
