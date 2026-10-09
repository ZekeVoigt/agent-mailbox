// Where the Vault's ciphertext lives: a GCS bucket, or (VAULT_ENV=local) a directory. Both answer the
// same calls, and only ever see bytes keeper has already encrypted. `generation` makes writes
// conditional, which is what the lease and the data key's first write rely on.
import {mkdir, readFile, writeFile, rm, readdir, stat, open as fopen, rename} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {join, dirname} from "node:path";
import {Readable} from "node:stream";

export class Conflict extends Error {}

// -- a GCS bucket, through its JSON API, as the VM's service account
export class Gcs {
  constructor(bucket, token) { this.bucket = bucket; this.token = token; }
  async call(url, init = {}, okStatuses = [200]) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, {...init, headers: {...(init.headers || {}),
        authorization: `Bearer ${await this.token()}`}});
      if (r.status === 412) throw new Conflict(`precondition failed: ${url.split("?")[0]}`);
      if (okStatuses.includes(r.status)) return r;
      if (r.status === 404) return null;
      const retry = r.status === 429 || r.status >= 500;
      const body = await r.text();
      if (!retry || attempt >= 5 || init.body instanceof Readable) throw new Error(`GCS ${r.status}: ${body.slice(0, 300)}`);
      await new Promise(f => setTimeout(f, 200 * 2 ** attempt));
    }
  }
  o(name) { return `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(name)}`; }
  // body: a Buffer, or a file path (streamed); ifGeneration: 0 = only if absent, n = only if still n
  async put(name, body, ifGeneration) {
    const q = new URLSearchParams({uploadType: "media", name});
    if (ifGeneration !== undefined) q.set("ifGenerationMatch", String(ifGeneration));
    const init = {method: "POST", headers: {"content-type": "application/octet-stream"}};
    if (typeof body === "string") {
      init.headers["content-length"] = String((await stat(body)).size);
      init.body = Readable.toWeb(createReadStream(body)); init.duplex = "half";
    } else init.body = body;
    const r = await this.call(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?${q}`, init);
    const o = await r.json();
    return {generation: Number(o.generation)};
  }
  async get(name, start, end) {         // -> Buffer | null; end inclusive
    const headers = start !== undefined ? {range: `bytes=${start}-${end ?? ""}`} : {};
    const r = await this.call(this.o(name) + "?alt=media", {headers}, [200, 206, 416]);
    if (!r) return null;
    if (r.status === 416) return Buffer.alloc(0);
    return Buffer.from(await r.arrayBuffer());
  }
  async head(name) {                    // -> {size, generation, created} | null
    const r = await this.call(this.o(name));
    if (!r) return null;
    const o = await r.json();
    return {size: Number(o.size), generation: Number(o.generation), created: Date.parse(o.timeCreated)};
  }
  async del(name, ifGeneration) {
    const q = ifGeneration !== undefined ? `?ifGenerationMatch=${ifGeneration}` : "";
    await this.call(this.o(name) + q, {method: "DELETE"}, [200, 204]);
  }
  async list(prefix, cursor, limit = 1000) {   // -> {items: [{name, size, created}], cursor}
    const q = new URLSearchParams({prefix, maxResults: String(limit), fields: "items(name,size,timeCreated),nextPageToken"});
    if (cursor) q.set("pageToken", cursor);
    const r = await this.call(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?${q}`);
    const o = r ? await r.json() : {};
    return {items: (o.items || []).map(x => ({name: x.name, size: Number(x.size), created: Date.parse(x.timeCreated)})),
      cursor: o.nextPageToken || null};
  }
}

// -- a directory, for local runs and tests: generations kept in <name>.gen beside each object
export class Local {
  constructor(root) { this.root = root; this.lock = Promise.resolve(); }
  path(name) { if (name.includes("..")) throw new Error("bad name"); return join(this.root, "o", name); }
  async gen(name) { try { return Number(await readFile(this.path(name) + ".gen", "utf8")); } catch { return 0; } }
  serial(f) { const p = this.lock.then(f, f); this.lock = p.catch(() => {}); return p; }
  put(name, body, ifGeneration) {
    return this.serial(async () => {
      const now = await this.gen(name);
      if (ifGeneration !== undefined && ifGeneration !== now) throw new Conflict(`precondition failed: ${name}`);
      const p = this.path(name);
      await mkdir(dirname(p), {recursive: true});
      await writeFile(p + ".tmp", typeof body === "string" ? await readFile(body) : body);
      await rename(p + ".tmp", p);
      await writeFile(p + ".gen", String(now + 1));
      return {generation: now + 1};
    });
  }
  async get(name, start, end) {
    let f;
    try { f = await fopen(this.path(name)); } catch { return null; }
    try {
      const size = (await f.stat()).size;
      const a = start ?? 0, b = Math.min(end ?? size - 1, size - 1);
      if (a > b) return Buffer.alloc(0);
      const buf = Buffer.alloc(b - a + 1);
      await f.read(buf, 0, buf.length, a);
      return buf;
    } finally { await f.close(); }
  }
  async head(name) {
    try {
      const s = await stat(this.path(name));
      return {size: s.size, generation: await this.gen(name), created: s.birthtimeMs || s.mtimeMs};
    } catch { return null; }
  }
  del(name, ifGeneration) {
    return this.serial(async () => {
      if (ifGeneration !== undefined && ifGeneration !== await this.gen(name)) throw new Conflict(`precondition failed: ${name}`);
      await rm(this.path(name), {force: true});
      await rm(this.path(name) + ".gen", {force: true});
    });
  }
  async list(prefix, cursor, limit = 1000) {
    const all = [];
    const walk = async (d, rel) => {
      let es = [];
      try { es = await readdir(d, {withFileTypes: true}); } catch { return; }
      for (const e of es) {
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) await walk(join(d, e.name), r);
        else if (!e.name.endsWith(".gen") && !e.name.endsWith(".tmp") && r.startsWith(prefix)) {
          const s = await stat(join(d, e.name));
          all.push({name: r, size: s.size, created: s.birthtimeMs || s.mtimeMs});
        }
      }
    };
    await walk(join(this.root, "o"), "");
    all.sort((a, b) => a.name < b.name ? -1 : 1);
    const from = cursor ? all.findIndex(x => x.name > cursor) : 0;
    const items = from < 0 ? [] : all.slice(from, from + limit);
    return {items, cursor: from >= 0 && from + limit < all.length ? items.at(-1).name : null};
  }
}
