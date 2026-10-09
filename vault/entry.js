// The Constellation inside the Vault: src/index.js, unchanged, on workerd instead of Cloudflare.
// This module supplies what Cloudflare's edge used to: request.cf (the caller's network, from the
// ASN table keeper holds), the two rate-limit bindings, R2 (MEDIA, kept by keeper encrypted), and the
// hourly cron. Everything else -- Durable Objects, fetch, crypto -- workerd provides itself.
import app, {Directory as D, Agent as A, Ledger as L, LinkRef as R, Box as B} from "./src/index.js";

// -- rate limits: Cloudflare's `ratelimits` bindings ({limit, period} a key), here in memory. One
// workerd process serves everything, so one map is the whole count, exact. Cloudflare's counters
// are approximate: its "600 a minute" served 1167 of a 1500 burst (SECURITY.md), and a normal e2e
// run peaks at 680 from one address -- so the exact limit here is what Cloudflare's let through
function limiter(name, limit, period) {
  const hits = new Map();             // key -> [window start, count]
  return {
    async limit({key}) {
      const now = Date.now(), w = hits.get(key);
      if (!w || now - w[0] >= period * 1000) {
        if (hits.size > 50000) hits.clear();
        hits.set(key, [now, 1]);
        return {success: true};
      }
      w[1]++;
      if (w[1] === limit + 1) console.log(JSON.stringify({at: "rate-limit", limit: name}));
      return {success: w[1] <= limit};
    },
  };
}
const RL_IP = limiter("RL_IP", 1200, 60), RL_MISS = limiter("RL_MISS", 30, 60);

// -- MEDIA: the subset of R2's API the app uses, over keeper's /blob store (encrypted at rest)
const BLOB = "http://keeper/blob/";
const enc = k => k.split("/").map(encodeURIComponent).join("/");
function objectOf(r, key) {
  const m = JSON.parse(r.headers.get("x-meta") || "{}");
  const size = +r.headers.get("x-size");
  return {
    key, size, uploaded: new Date(+r.headers.get("x-uploaded")),
    httpEtag: r.headers.get("etag"), etag: (r.headers.get("etag") || "").replace(/"/g, ""),
    httpMetadata: m.http || {}, customMetadata: m.custom || {},
    writeHttpMetadata(h) { if (m.http && m.http.contentType) h.set("content-type", m.http.contentType); },
  };
}
function media(keeper) {
  return {
    async put(key, body, opt = {}) {
      const r = await keeper.fetch(BLOB + enc(key), {method: "PUT", body,
        headers: {"x-meta": JSON.stringify({http: opt.httpMetadata || {}, custom: opt.customMetadata || {}})}});
      if (!r.ok) throw new Error(`media put: ${r.status} ${await r.text()}`);
      return objectOf(r, key);
    },
    async head(key) {
      const r = await keeper.fetch(BLOB + enc(key), {method: "HEAD"});
      return r.status === 404 ? null : objectOf(r, key);
    },
    async get(key, opt = {}) {
      const h = {};
      const range = opt.range instanceof Headers ? opt.range.get("range") : null;
      const inm = opt.onlyIf instanceof Headers ? opt.onlyIf.get("if-none-match") : null;
      if (range) h.range = range;
      if (inm) h["if-none-match"] = inm;
      const r = await keeper.fetch(BLOB + enc(key), {headers: h});
      if (r.status === 404) return null;
      const o = objectOf(r, key);
      if (r.status === 304) return o;           // a precondition failed: R2 answers with no body
      const cr = r.headers.get("content-range");
      if (cr) {
        const [, a, b] = cr.match(/bytes (\d+)-(\d+)\//);
        o.range = {offset: +a, length: +b - +a + 1};
      }
      o.body = r.body;
      return o;
    },
    async delete(keys) {
      const r = await keeper.fetch("http://keeper/blobs/delete", {method: "POST",
        body: JSON.stringify({keys: Array.isArray(keys) ? keys : [keys]})});
      if (!r.ok) throw new Error(`media delete: ${r.status}`);
    },
    async list({prefix = "", cursor, limit = 1000} = {}) {
      const q = new URLSearchParams({prefix, limit: String(limit)});
      if (cursor) q.set("cursor", cursor);
      const got = await (await keeper.fetch("http://keeper/blobs?" + q)).json();
      return {objects: got.objects.map(o => ({key: o.key, size: o.size, uploaded: new Date(o.uploaded)})),
        truncated: !!got.cursor, cursor: got.cursor || undefined};
    },
  };
}

// the bindings the app reads, with Cloudflare's own filled in; Durable Objects get the same env
const sealed = env => ({...env, RL_IP, RL_MISS, MEDIA: media(env.KEEPER)});

// -- request.cf: the caller's network (asn, asOrganization), which the app pins chatbot links to
const asns = new Map();               // ip -> {asn, asOrganization}, a bounded cache
async function cfOf(env, ip) {
  if (!ip) return {};
  let got = asns.get(ip);
  if (!got) {
    try { got = await (await env.KEEPER.fetch("http://keeper/asn?ip=" + encodeURIComponent(ip))).json(); }
    catch { got = {}; }
    if (asns.size > 20000) asns.clear();
    asns.set(ip, got);
  }
  return got;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__vault/")) {
      // keeper's own calls; Caddy strips this header from every request it forwards
      if (!env.VAULT_INTERNAL || req.headers.get("x-vault-internal") !== env.VAULT_INTERNAL)
        return new Response("Unknown address.", {status: 404});
      if (url.pathname === "/__vault/scheduled") {
        await app.scheduled({cron: "17 * * * *", scheduledTime: Date.now()}, sealed(env), ctx);
        return new Response("ok");
      }
      // the owner's restore (keeper/restore.js): the deletions to make again, then making them
      const doCall = async (ns, name, path) => ns.get(ns.idFromName(name)).fetch("https://do" + path,
        {method: "POST", body: await req.text()});
      if (url.pathname === "/__vault/ledger-since") return doCall(env.LEDGER, "ledger", "/since");
      if (url.pathname === "/__vault/reapply") return doCall(env.DIR, "directory", "/reapply");
      return new Response("Unknown.", {status: 404});
    }
    const cf = await cfOf(env, req.headers.get("cf-connecting-ip"));
    return app.fetch(new Request(req, {cf}), sealed(env), ctx);
  },
};

export class Directory extends D { constructor(state, env) { super(state, sealed(env)); } }
export class Agent extends A { constructor(state, env) { super(state, sealed(env)); } }
export class Ledger extends L { constructor(state, env) { super(state, sealed(env)); } }
export class LinkRef extends R { constructor(state, env) { super(state, sealed(env)); } }
export class Box extends B { constructor(state, env) { super(state, sealed(env)); } }
