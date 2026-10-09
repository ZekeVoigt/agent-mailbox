// Media (photos, videos, GIFs): R2's role, for the app's MEDIA binding (vault/entry.js). Each object
// is encrypted in 64 KiB chunks before it leaves the enclave, so a range of a video is read and
// decrypted on its own. An upload is sealed into a file on the tmpfs, then handed to the store.
import {open as fopen, rm, mkdir} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {CHUNK, TAG, headerFor, readHeader, sealChunk, openChunk, mac} from "./crypto.js";

const KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const name = key => "media/" + key;

export function blobs({store, keys, tmp}) {
  const etagOf = (key, prefix) => `"${mac(keys.mac, Buffer.concat([Buffer.from("etag:" + key + ":"), prefix])).subarray(0, 16).toString("hex")}"`;

  async function header(key) {
    let buf = await store.get(name(key), 0, 4095);
    if (!buf) return null;
    let h = readHeader(keys.media, buf);
    if (h && h.need) { buf = await store.get(name(key), 0, h.need - 1); h = readHeader(keys.media, buf); }
    if (!h || h.need) throw new Error("media: a header is cut short");
    return h;
  }
  const headersOf = (key, h, created) => ({"x-meta": JSON.stringify(h.meta), "x-size": String(h.size),
    "x-uploaded": String(created), etag: etagOf(key, h.prefix)});

  async function put(key, req, res) {
    const size = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size < 0) return send(res, 411, "a length is required");
    let meta;
    try { meta = JSON.parse(req.headers["x-meta"] || "{}"); } catch { return send(res, 400, "bad x-meta"); }
    const prefix = randomBytes(8), hd = headerFor(keys.media, prefix, size, meta), fixed = hd.subarray(0, 20);
    await mkdir(tmp, {recursive: true});
    const path = `${tmp}/up-${randomBytes(8).toString("hex")}`;
    const f = await fopen(path, "w");
    try {
      await f.write(hd);
      let pending = Buffer.alloc(0), i = 0, got = 0;
      for await (const part of req) {
        got += part.length;
        if (got > size) return send(res, 400, "more bytes than its length");
        pending = pending.length ? Buffer.concat([pending, part]) : part;
        while (pending.length >= CHUNK) {
          await f.write(sealChunk(keys.media, fixed, i++, pending.subarray(0, CHUNK)));
          pending = pending.subarray(CHUNK);
        }
      }
      if (got !== size) return send(res, 400, "the upload was cut short");
      if (pending.length) await f.write(sealChunk(keys.media, fixed, i++, pending));
      await f.close();
      await store.put(name(key), path);
      const now = Date.now();
      return send(res, 200, "", headersOf(key, {meta, size, prefix}, now));
    } finally {
      await f.close().catch(() => {});
      await rm(path, {force: true});
    }
  }

  async function get(key, req, res, headOnly) {
    const o = await store.head(name(key));
    if (!o) return send(res, 404, "");
    const h = await header(key);
    const hd = headersOf(key, h, o.created);
    if (req.headers["if-none-match"] && req.headers["if-none-match"] === hd.etag) return send(res, 304, "", hd);
    if (headOnly) return send(res, 200, "", hd);
    let a = 0, b = h.size - 1, status = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r && h.size > 0 && (r[1] || r[2])) {
      if (r[1]) { a = +r[1]; b = r[2] ? Math.min(+r[2], h.size - 1) : h.size - 1; }
      else { a = Math.max(0, h.size - +r[2]); }
      if (a > b || a >= h.size) return send(res, 416, "", {...hd, "content-range": `bytes */${h.size}`});
      status = 206;
      hd["content-range"] = `bytes ${a}-${b}/${h.size}`;
    }
    res.writeHead(status, {...hd, "content-length": String(h.size ? b - a + 1 : 0)});
    if (!h.size) return res.end();
    const C = CHUNK + TAG, first = Math.floor(a / CHUNK), last = Math.floor(b / CHUNK);
    for (let i = first; i <= last; i += 16) {
      const j = Math.min(last, i + 15);
      const box = await store.get(name(key), h.length + i * C, h.length + (j + 1) * C - 1);
      for (let k = i, off = 0; k <= j; k++) {
        const len = Math.min(C, box.length - off);
        const plain = openChunk(keys.media, h.fixed, k, box.subarray(off, off + len));
        off += len;
        const s = k === first ? a - k * CHUNK : 0, e = k === last ? b - k * CHUNK + 1 : plain.length;
        if (!res.write(plain.subarray(s, e))) await new Promise(f => res.once("drain", f));
      }
    }
    res.end();
  }

  async function list(q, res) {
    const got = await store.list(name(q.get("prefix") || ""), q.get("cursor") || null, Math.min(1000, +q.get("limit") || 1000));
    send(res, 200, JSON.stringify({objects: got.items.map(x => ({key: x.name.slice(6), size: x.size, uploaded: x.created})),
      cursor: got.cursor}), {"content-type": "application/json"});
  }

  async function del(req, res) {
    let body = "";
    for await (const c of req) body += c;
    const {keys: ks = []} = JSON.parse(body || "{}");
    for (const k of ks) if (KEY_RE.test(k)) await store.del(name(k));
    send(res, 200, "{}");
  }

  return async function handle(req, res, url) {
    if (url.pathname === "/blobs" && req.method === "GET") return list(url.searchParams, res);
    if (url.pathname === "/blobs/delete" && req.method === "POST") return del(req, res);
    const key = decodeURIComponent(url.pathname.slice(6));
    if (!KEY_RE.test(key)) return send(res, 400, "bad key");
    if (req.method === "PUT") return put(key, req, res);
    if (req.method === "GET" || req.method === "HEAD") return get(key, req, res, req.method === "HEAD");
    return send(res, 405, "");
  };
}

export function send(res, status, body, headers = {}) {
  // a failure after the headers went out (a chunk that will not decrypt): cut the connection, so
  // the reader sees a broken response rather than a short one that looks whole
  if (res.headersSent) return res.destroy();
  res.writeHead(status, headers);
  res.end(body);
}
