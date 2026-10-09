// Snapshots of the Vault's state (Durable Object storage, Caddy's certificate), which lives only in
// RAM (a tmpfs): every few seconds the files that changed are copied while workerd is frozen
// (SIGSTOP, milliseconds), then encrypted and uploaded. A copy taken mid-transaction is exactly a
// power cut, which SQLite recovers from; the -shm files are left out (SQLite rebuilds them).
//
//   snap/b/<hmac of the plaintext>   one file's bytes, sealed (content-addressed: written once)
//   snap/m/<seq, 12 digits>          a manifest: every file's path -> {h, size}, sealed
// A manifest is written only after every file it names, so the newest one is always whole.
import {mkdir, readdir, readFile, stat, writeFile, rm} from "node:fs/promises";
import {join, dirname, relative} from "node:path";
import {seal, open, mac} from "./crypto.js";

const pad = n => String(n).padStart(12, "0");
const SKIP = /(-shm|\.tmp|\.lock)$/;

async function walk(root) {          // -> [[relative path, stats]]
  const out = [];
  const go = async d => {
    let es = [];
    try { es = await readdir(d, {withFileTypes: true}); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) await go(p);
      else if (e.isFile() && !SKIP.test(e.name)) out.push([relative(root, p), await stat(p, {bigint: true})]);
    }
  };
  await go(root);
  return out;
}

export class Snapshots {
  // roots: {name: dir}; keys: {box, mac}; freeze: async fn => runs fn with workerd stopped
  constructor({store, keys, roots, freeze, held, log}) {
    Object.assign(this, {store, keys, roots, freeze, held, log});
    this.seen = new Map();            // path -> {mt, size, h}
    this.have = new Set();            // blob hashes known to be in the store
    this.seq = 0;
    this.busy = null;
  }
  blobName(h) { return "snap/b/" + h; }
  manifestName(seq) { return "snap/m/" + pad(seq); }

  async latest() {                    // -> [seq, manifest] or [0, null]
    let cursor = null, last = null;
    do {
      const got = await this.store.list("snap/m/", cursor);
      if (got.items.length) last = got.items.at(-1).name;
      cursor = got.cursor;
    } while (cursor);
    if (!last) return [0, null];
    const seq = Number(last.slice(7));
    return [seq, await this.readManifest(seq)];
  }
  async readManifest(seq) {
    const box = await this.store.get(this.manifestName(seq));
    return JSON.parse(open(this.keys.box, box, "manifest:" + seq).toString());
  }

  // before workerd starts: the newest snapshot's files, written back into the roots
  async restore() {
    const [seq, m] = await this.latest();
    this.seq = seq;
    if (!m) { this.log("restore: no snapshot yet, starting empty"); return 0; }
    let bytes = 0;
    for (const [path, f] of Object.entries(m.files)) {
      const [root, ...rest] = path.split("/");
      if (!this.roots[root]) continue;
      const box = await this.store.get(this.blobName(f.h));
      if (!box) throw new Error(`restore: snapshot ${seq} names a missing file`);
      const plain = open(this.keys.box, box, "file:" + f.h);
      if (mac(this.keys.mac, plain).toString("hex") !== f.h) throw new Error("restore: a file does not match its hash");
      const p = join(this.roots[root], ...rest);
      await mkdir(dirname(p), {recursive: true});
      await writeFile(p, plain);
      const s = await stat(p, {bigint: true});
      this.seen.set(path, {mt: s.mtimeNs, size: s.size, h: f.h});
      this.have.add(f.h);
      bytes += plain.length;
    }
    this.log(`restore: snapshot ${seq}, ${Object.keys(m.files).length} files, ${bytes} bytes`);
    return seq;
  }

  // one snapshot, if anything changed; returns its seq or 0. `frozen` = workerd already stopped
  take(frozen = false) {
    if (this.inside) return this.#take(frozen);   // already running exclusively (the owner's restore)
    const run = (this.busy || Promise.resolve()).then(() => this.#take(frozen));
    this.busy = run.catch(() => {});
    return run;
  }
  async #take(frozen) {
    const copied = new Map();         // path -> {mt, size, plain}
    let present = new Set();
    const scan = async () => {
      for (const [name, dir] of Object.entries(this.roots)) {
        for (const [rel, s] of await walk(dir)) {
          const path = name + "/" + rel;
          present.add(path);
          const was = this.seen.get(path);
          if (was && was.mt === s.mtimeNs && was.size === s.size) continue;
          try { copied.set(path, {mt: s.mtimeNs, size: s.size, plain: await readFile(join(dir, rel))}); }
          catch { present.delete(path); }   // gone between the listing and the read
        }
      }
    };
    if (frozen) await scan(); else await this.freeze(scan);
    const gone = [...this.seen.keys()].filter(p => !present.has(p));
    if (!copied.size && !gone.length) return 0;
    for (const [path, c] of copied) {
      const h = mac(this.keys.mac, c.plain).toString("hex");
      if (!this.have.has(h)) {
        await this.store.put(this.blobName(h), seal(this.keys.box, c.plain, "file:" + h));
        this.have.add(h);
      }
      c.h = h;
    }
    const files = {};
    for (const [path, f] of this.seen) if (present.has(path) && !copied.has(path)) files[path] = {h: f.h, size: Number(f.size)};
    for (const [path, c] of copied) files[path] = {h: c.h, size: Number(c.size)};
    if (!(await this.held())) throw new Error("snapshot: the lease is not held; not writing a manifest");
    const seq = this.seq + 1;
    const body = Buffer.from(JSON.stringify({v: 1, seq, at: Date.now(), files}));
    await this.store.put(this.manifestName(seq), seal(this.keys.box, body, "manifest:" + seq), 0);
    this.seq = seq;
    for (const p of gone) this.seen.delete(p);
    for (const [path, c] of copied) this.seen.set(path, {mt: c.mt, size: c.size, h: c.h});
    return seq;
  }

  // runs fn while no snapshot is being taken (the owner's restore swaps files under workerd)
  exclusive(fn) {
    const go = async () => { this.inside = true; try { return await fn(); } finally { this.inside = false; } };
    const run = (this.busy || Promise.resolve()).then(go, go);
    this.busy = run.catch(() => {});
    return run;
  }

  // the newest snapshot taken at or before `at` -> [seq, manifest] or [0, null]
  async at(at) {
    let cursor = null, best = null;
    do {
      const got = await this.store.list("snap/m/", cursor);
      for (const x of got.items) if (x.created <= at) best = x;
      cursor = got.cursor;
    } while (cursor);
    if (!best) return [0, null];
    const seq = Number(best.name.slice(7));
    return [seq, await this.readManifest(seq)];
  }

  // one directory of a root (e.g. "do/constellation-directory/") put back as manifest m had it;
  // workerd must be stopped. The next snapshot records the change.
  async putBack(m, prefix) {
    const [root, ...rest] = prefix.replace(/\/$/, "").split("/");
    const dir = join(this.roots[root], ...rest);
    await rm(dir, {recursive: true, force: true});
    await mkdir(dir, {recursive: true});
    let n = 0;
    for (const [path, f] of Object.entries(m.files)) {
      if (!path.startsWith(prefix)) continue;
      const plain = open(this.keys.box, await this.store.get(this.blobName(f.h)), "file:" + f.h);
      if (mac(this.keys.mac, plain).toString("hex") !== f.h) throw new Error("restore: a file does not match its hash");
      const p = join(this.roots[root], ...path.split("/").slice(1));
      await mkdir(dirname(p), {recursive: true});
      await writeFile(p, plain);
      n++;
    }
    for (const p of [...this.seen.keys()]) if (p.startsWith(prefix)) this.seen.delete(p);
    return n;
  }

  // keep: every manifest of the last hour, the newest of each hour for a day, of each day for a
  // week; then every blob no kept manifest names (and older than an hour, so none in flight)
  async gc(now = Date.now()) {
    const ms = [];
    let cursor = null;
    do {
      const got = await this.store.list("snap/m/", cursor);
      ms.push(...got.items);
      cursor = got.cursor;
    } while (cursor);
    if (!ms.length) return {manifests: 0, blobs: 0};
    const keep = new Set([ms.at(-1).name]), byHour = new Map(), byDay = new Map();
    for (const m of ms) {
      const age = now - m.created;
      if (age < 3600e3) keep.add(m.name);
      else if (age < 86400e3) byHour.set(Math.floor(m.created / 3600e3), m.name);
      else if (age < 7 * 86400e3) byDay.set(Math.floor(m.created / 86400e3), m.name);
    }
    for (const n of [...byHour.values(), ...byDay.values()]) keep.add(n);
    let dm = 0, db = 0;
    for (const m of ms) if (!keep.has(m.name)) { await this.store.del(m.name); dm++; }
    const used = new Set();
    for (const n of keep) {
      const seq = Number(n.slice(7));
      for (const f of Object.values((await this.readManifest(seq)).files)) used.add(f.h);
    }
    cursor = null;
    do {
      const got = await this.store.list("snap/b/", cursor);
      for (const b of got.items) {
        const h = b.name.slice(7);
        if (!used.has(h) && now - b.created > 3600e3) { await this.store.del(b.name); this.have.delete(h); db++; }
      }
      cursor = got.cursor;
    } while (cursor);
    return {manifests: dm, blobs: db};
  }
}

export async function emptyDirs(roots) {
  for (const d of Object.values(roots)) { await rm(d, {recursive: true, force: true}); await mkdir(d, {recursive: true}); }
}
