// The owner's restore (POST /admin/restore, ADMIN_OWNER only): the directory as the newest snapshot
// at or before `at` had it, then every deletion since (from the Ledger, which is not restored) made
// again -- the Vault's version of the Worker's point-in-time restore. Agents' conversations are not
// touched. workerd is stopped for the swap (a second or two of 502s).
import {timingSafeEqual, createHash} from "node:crypto";
import {send} from "./blobs.js";

const sameSecret = (a, b) => {
  const x = createHash("sha256").update(String(a)).digest(), y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
};
const fails = new Map();             // ip -> [minute, count]: 30 wrong keys a minute, then 429

export function restorer({snaps, owner, internal, restartWorkerd, log}) {
  const inside = (path, body) => fetch("http://127.0.0.1:8080" + path, {method: "POST",
    headers: {"x-vault-internal": internal}, body: JSON.stringify(body)}).then(async r => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });

  return async function handle(req, res) {
    const ip = req.headers["cf-connecting-ip"] || "";
    const minute = Math.floor(Date.now() / 60e3), f = fails.get(ip);
    if (f && f[0] === minute && f[1] >= 30) return send(res, 429, "Too many requests: try again in a minute.");
    if (req.method !== "POST") return send(res, 404, "Unknown address.");
    if (!owner || !sameSecret(req.headers["x-admin"] || "", owner)) {
      fails.set(ip, f && f[0] === minute ? [minute, f[1] + 1] : [minute, 1]);
      if (fails.size > 10000) fails.clear();
      return send(res, 403, "Not allowed: that needs the owner's key.", {"content-type": "text/plain; charset=utf-8"});
    }
    let body = "";
    for await (const c of req) { body += c; if (body.length > 10000) return send(res, 413, ""); }
    const at = Number(JSON.parse(body || "{}").at);
    if (!(at > 0)) return send(res, 400, "Give the time to restore to: {\"at\": <ms since 1970>}.");
    log(`admin restore (owner key) to ${new Date(at).toISOString()}`);
    const gone = await inside("/__vault/ledger-since", {at});
    const [seq, m] = await snaps.at(at);
    if (!m) return send(res, 409, JSON.stringify({error: "No snapshot that old is kept."}), {"content-type": "application/json"});
    let files = 0;
    await restartWorkerd(async () => { files = await snaps.putBack(m, "do/constellation-directory/"); });
    let again = false;
    for (let i = 0; i < 20 && !again; i++) {
      try { again = (await inside("/__vault/reapply", gone)).ok; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    log(`admin restore: snapshot ${seq} (${new Date(m.at).toISOString()}), ${files} files, deletions made again: ${again}`);
    return send(res, 200, JSON.stringify({restored: at, snapshot: seq, snapshot_at: m.at, deleted_again: gone, reapplied: again}),
      {"content-type": "application/json"});
  };
}
