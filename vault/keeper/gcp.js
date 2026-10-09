// Google Cloud from inside the Confidential Space VM.
//   - the VM's service account (metadata server): GCS and Secret Manager -- ciphertext and the
//     operator's own keys, nothing a person wrote;
//   - the attested workload (Confidential Space token -> STS -> a federated token): Cloud KMS, whose
//     key unwraps the data key only for an image digest on the allowed list.
import http from "node:http";

const META = "http://metadata.google.internal/computeMetadata/v1/";
export const TEE_SOCK = "/run/container_launcher/teeserver.sock";

function cached(get) {               // a token, refreshed a minute before it expires
  let tok = null, until = 0, pending = null;
  return async () => {
    if (tok && Date.now() < until - 60e3) return tok;
    pending = pending || get().then(([t, ttl]) => { tok = t; until = Date.now() + ttl * 1000; return t; })
      .finally(() => { pending = null; });
    return pending;
  };
}

export const vmToken = cached(async () => {
  const r = await fetch(META + "instance/service-accounts/default/token", {headers: {"Metadata-Flavor": "Google"}});
  if (!r.ok) throw new Error(`metadata token: ${r.status}`);
  const o = await r.json();
  return [o.access_token, o.expires_in];
});

export async function project() {
  const r = await fetch(META + "project/project-id", {headers: {"Metadata-Flavor": "Google"}});
  return r.text();
}

// a Confidential Space attestation token from the launcher's local server
export function teeToken(audience, nonces) {
  const body = JSON.stringify({audience, token_type: "OIDC", ...(nonces && nonces.length ? {nonces} : {})});
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath: TEE_SOCK, path: "/v1/token", method: "POST",
      headers: {"content-type": "application/json", "content-length": Buffer.byteLength(body)}}, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => res.statusCode === 200 ? resolve(d.trim()) : reject(new Error(`teeserver ${res.statusCode}: ${d}`)));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// the attested workload's federated token: the attestation token exchanged at STS for the pool's
// provider (whose attribute condition names the allowed image digests)
export function workloadToken(provider) {
  return cached(async () => {
    const subject = await teeToken("https://sts.googleapis.com");
    const r = await fetch("https://sts.googleapis.com/v1/token", {method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({audience: "//iam.googleapis.com/" + provider,
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt", subjectToken: subject})});
    const o = await r.json();
    if (!r.ok) throw new Error(`STS: ${r.status} ${JSON.stringify(o).slice(0, 300)}`);
    return [o.access_token, o.expires_in];
  });
}

export async function kms(token, key, op, field, value) {
  const r = await fetch(`https://cloudkms.googleapis.com/v1/${key}:${op}`, {method: "POST",
    headers: {authorization: `Bearer ${await token()}`, "content-type": "application/json"},
    body: JSON.stringify({[field]: value.toString("base64")})});
  const o = await r.json();
  if (!r.ok) throw new Error(`KMS ${op}: ${r.status} ${JSON.stringify(o).slice(0, 300)}`);
  return Buffer.from(o[op === "encrypt" ? "ciphertext" : "plaintext"], "base64");
}

export async function secret(name) {           // projects/P/secrets/S -> its latest value, or "" if absent
  const r = await fetch(`https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`,
    {headers: {authorization: `Bearer ${await vmToken()}`}});
  if (r.status === 404) return "";              // no such secret, or no value set yet
  const o = await r.json();
  if (r.status === 400 && /state DESTROYED|state DISABLED|no versions/i.test(JSON.stringify(o))) return "";
  if (!r.ok) throw new Error(`Secret Manager ${name}: ${r.status} ${JSON.stringify(o).slice(0, 200)}`);
  return Buffer.from(o.payload.data, "base64").toString();
}
