// keeper's own proof, no Docker and no cloud: `node --test vault/test/`
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {mkdtemp, writeFile, readFile, rm, mkdir, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import {Local, Conflict} from "../keeper/store.js";
import {Snapshots} from "../keeper/snap.js";
import {Lease} from "../keeper/lease.js";
import {blobs, send} from "../keeper/blobs.js";
import {derive, seal, open, headerFor, readHeader, sealChunk, openChunk, CHUNK} from "../keeper/crypto.js";
import * as asn from "../keeper/asn.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), "vault-test-"));
const keysOf = dk => ({box: derive(dk, "snapshot"), mac: derive(dk, "mac"), media: derive(dk, "media")});
const quiet = () => {};

test("sealed values open only with their key and their AAD", () => {
  const k = randomBytes(32), box = seal(k, Buffer.from("hello"), "a");
  assert.equal(open(k, box, "a").toString(), "hello");
  assert.throws(() => open(k, box, "b"));
  assert.throws(() => open(randomBytes(32), box, "a"));
  const bad = Buffer.from(box); bad[14] ^= 1;
  assert.throws(() => open(k, bad, "a"));
});

test("each purpose has its own key", () => {
  const dk = randomBytes(32);
  assert.notDeepEqual(derive(dk, "snapshot"), derive(dk, "media"));
  assert.deepEqual(derive(dk, "media"), derive(dk, "media"));
});

test("a media chunk fails to open if the size, the index or another file's header is swapped in", () => {
  const k = randomBytes(32), p = randomBytes(8);
  const h = headerFor(k, p, 10, {x: 1}), fixed = h.subarray(0, 20);
  const c = sealChunk(k, fixed, 0, Buffer.from("0123456789"));
  assert.equal(openChunk(k, fixed, 0, c).toString(), "0123456789");
  assert.throws(() => openChunk(k, fixed, 1, c), "another index");
  const resized = headerFor(k, p, 11, {x: 1}).subarray(0, 20);
  assert.throws(() => openChunk(k, resized, 0, c), "another size");
  const other = headerFor(k, randomBytes(8), 10, {x: 1}).subarray(0, 20);
  assert.throws(() => openChunk(k, other, 0, c), "another file");
  assert.deepEqual(readHeader(k, h).meta, {x: 1});
});

async function mediaServer() {
  const dir = await tmp(), store = new Local(join(dir, "store"));
  const handle = blobs({store, keys: keysOf(randomBytes(32)), tmp: join(dir, "tmp")});
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, "http://x")).catch(() => send(res, 500, "")));
  await new Promise(f => server.listen(0, "127.0.0.1", f));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {dir, store, base, close: () => new Promise(f => { server.close(f); server.closeAllConnections(); })};
}

test("media: stored encrypted, read whole and by any range, 304 on its etag, listed, deleted", async () => {
  const m = await mediaServer();
  try {
    const data = randomBytes(3 * CHUNK + 1234);
    const put = await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop", {method: "PUT", body: data,
      headers: {"x-meta": JSON.stringify({http: {contentType: "video/mp4"}, custom: {k: "v", w: "640"}})}});
    assert.equal(put.status, 200);
    const etag = put.headers.get("etag");
    // at rest: no run of the plaintext appears in the stored bytes
    const raw = await readFile(join(m.dir, "store", "o", "media", "m", "zeke", "abcdefghijklmnop"));
    assert.equal(raw.indexOf(data.subarray(1000, 1032)), -1);
    const whole = Buffer.from(await (await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop")).arrayBuffer());
    assert.ok(whole.equals(data));
    for (const [range, a, b] of [["bytes=0-0", 0, 0], [`bytes=${CHUNK - 2}-${CHUNK + 2}`, CHUNK - 2, CHUNK + 2],
      ["bytes=-10", data.length - 10, data.length - 1], [`bytes=${2 * CHUNK}-`, 2 * CHUNK, data.length - 1],
      [`bytes=5-${data.length + 99}`, 5, data.length - 1]]) {
      const r = await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop", {headers: {range}});
      assert.equal(r.status, 206, range);
      assert.equal(r.headers.get("content-range"), `bytes ${a}-${b}/${data.length}`, range);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(a, b + 1)), range);
    }
    assert.equal((await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop", {headers: {range: `bytes=${data.length}-`}})).status, 416);
    const nm = await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop", {headers: {"if-none-match": etag}});
    assert.equal(nm.status, 304);
    const head = await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop", {method: "HEAD"});
    assert.deepEqual(JSON.parse(head.headers.get("x-meta")).custom, {k: "v", w: "640"});
    assert.equal(head.headers.get("x-size"), String(data.length));
    const empty = await fetch(m.base + "/blob/m/zeke/0000000000000000", {method: "PUT", body: Buffer.alloc(0)});
    assert.equal(empty.status, 200);
    assert.equal((await (await fetch(m.base + "/blob/m/zeke/0000000000000000")).arrayBuffer()).byteLength, 0);
    const listed = await (await fetch(m.base + "/blobs?prefix=m/zeke/")).json();
    assert.deepEqual(listed.objects.map(o => o.key).sort(), ["m/zeke/0000000000000000", "m/zeke/abcdefghijklmnop"]);
    await fetch(m.base + "/blobs/delete", {method: "POST", body: JSON.stringify({keys: ["m/zeke/abcdefghijklmnop", "../etc"]})});
    assert.equal((await fetch(m.base + "/blob/m/zeke/abcdefghijklmnop")).status, 404);
    // a stored byte changed: the read breaks rather than returning altered bytes
    await fetch(m.base + "/blob/m/zeke/1111111111111111", {method: "PUT", body: data});
    const p3 = join(m.dir, "store", "o", "media", "m", "zeke", "1111111111111111");
    const bytes = await readFile(p3); bytes[bytes.length - 100] ^= 1; await writeFile(p3, bytes);
    const tampered = await fetch(m.base + "/blob/m/zeke/1111111111111111", {headers: {range: "bytes=-5"}})
      .then(r => r.arrayBuffer()).then(() => "read", () => "broken");
    assert.equal(tampered, "broken");
  } finally { await m.close(); await rm(m.dir, {recursive: true, force: true}); }
});

test("media: an upload shorter than its length is refused and leaves nothing", async () => {
  const m = await mediaServer();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(m.base + "/blob/m/zeke/2222222222222222", {method: "PUT", headers: {"content-length": "100"}}, r => resolve(r.statusCode));
      req.on("error", () => resolve("cut"));
      req.write(Buffer.alloc(40)); setTimeout(() => req.destroy(), 100);
    });
    assert.ok(status === "cut" || status === 400);
    await new Promise(f => setTimeout(f, 100));
    assert.equal((await fetch(m.base + "/blob/m/zeke/2222222222222222")).status, 404);
    assert.deepEqual(await readdir(join(m.dir, "tmp")), []);
  } finally { await m.close(); await rm(m.dir, {recursive: true, force: true}); }
});

async function snapRig(store, dk, base) {
  const roots = {do: join(base, "do"), caddy: join(base, "caddy")};
  for (const d of Object.values(roots)) await mkdir(d, {recursive: true});
  let froze = 0;
  const s = new Snapshots({store, keys: keysOf(dk), roots, freeze: async fn => { froze++; return fn(); }, held: () => true, log: quiet});
  return {s, roots, froze: () => froze};
}

test("snapshots: only what changed is copied; a fresh Vault restores the newest exactly", async () => {
  const dir = await tmp(), store = new Local(join(dir, "store")), dk = randomBytes(32);
  try {
    const a = await snapRig(store, dk, join(dir, "a"));
    await mkdir(join(a.roots.do, "constellation-agent"), {recursive: true});
    await writeFile(join(a.roots.do, "constellation-agent", "x.sqlite"), "agent x v1");
    await writeFile(join(a.roots.do, "constellation-agent", "x.sqlite-shm"), "shared memory");
    await writeFile(join(a.roots.do, "constellation-agent", "y.sqlite"), "agent y");
    await writeFile(join(a.roots.caddy, "cert.pem"), "a certificate");
    assert.equal(await a.s.take(), 1);
    assert.equal(await a.s.take(), 0, "nothing changed: no new snapshot");
    await new Promise(f => setTimeout(f, 5));
    await writeFile(join(a.roots.do, "constellation-agent", "x.sqlite"), "agent x v2");
    await rm(join(a.roots.do, "constellation-agent", "y.sqlite"));
    assert.equal(await a.s.take(), 2);
    assert.ok(a.froze() >= 3, "every scan ran frozen");
    // nothing in the store is plaintext
    for (const n of (await store.list("snap/")).items)
      assert.equal((await store.get(n.name)).indexOf("agent x"), -1, n.name);
    const b = await snapRig(store, dk, join(dir, "b"));
    assert.equal(await b.s.restore(), 2);
    assert.equal(await readFile(join(b.roots.do, "constellation-agent", "x.sqlite"), "utf8"), "agent x v2");
    await assert.rejects(readFile(join(b.roots.do, "constellation-agent", "y.sqlite")));
    await assert.rejects(readFile(join(b.roots.do, "constellation-agent", "x.sqlite-shm")), "-shm is left out");
    assert.equal(await readFile(join(b.roots.caddy, "cert.pem"), "utf8"), "a certificate");
    assert.equal(await b.s.take(), 0, "a restored Vault does not re-upload what it restored");
    const wrong = await snapRig(store, randomBytes(32), join(dir, "c"));
    await assert.rejects(wrong.s.restore(), "another data key opens nothing");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("snapshots: no manifest is written without the lease", async () => {
  const dir = await tmp(), store = new Local(join(dir, "store"));
  try {
    const roots = {do: join(dir, "do")};
    await mkdir(roots.do, {recursive: true});
    await writeFile(join(roots.do, "f"), "x");
    const s = new Snapshots({store, keys: keysOf(randomBytes(32)), roots, freeze: fn => fn(), held: () => false, log: quiet});
    await assert.rejects(s.take(), /lease/);
    assert.equal((await store.list("snap/m/")).items.length, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("snapshots: gc keeps the newest and every file it names, and removes the rest", async () => {
  const dir = await tmp(), store = new Local(join(dir, "store")), dk = randomBytes(32);
  try {
    const a = await snapRig(store, dk, join(dir, "a"));
    for (let i = 0; i < 4; i++) {
      await writeFile(join(a.roots.do, "f"), "version " + i);
      await new Promise(f => setTimeout(f, 5));
      await a.s.take();
    }
    const r = await a.s.gc(Date.now() + 30 * 86400e3);
    assert.deepEqual(r, {manifests: 3, blobs: 3});
    const b = await snapRig(store, dk, join(dir, "b"));
    assert.equal(await b.s.restore(), 4);
    assert.equal(await readFile(join(b.roots.do, "f"), "utf8"), "version 3");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("lease: a second Vault waits for the first; a stolen lease stops the holder", async () => {
  const dir = await tmp(), store = new Local(join(dir, "store"));
  try {
    const a = new Lease(store, quiet, () => {});
    await a.acquire();
    const b = new Lease(store, quiet, () => {});
    let bHeld = false;
    const bGot = b.acquire().then(() => { bHeld = true; });
    await new Promise(f => setTimeout(f, 300));
    assert.equal(bHeld, false, "B waits while A holds it");
    await a.release();
    await bGot;
    assert.ok(b.held());
    // C takes it over (as if B's lease had lapsed): B's next renewal finds out and stops
    let lost = null;
    b.onLost = why => { lost = why; };
    const g = (await store.head("lease")).generation;
    await store.put("lease", Buffer.from(JSON.stringify({holder: "c", until: Date.now() + 60e3})), g);
    await b.renew();
    assert.match(lost, /another Vault/);
    assert.equal(b.held(), false);
    await assert.rejects(store.put("lease", Buffer.from("x"), 0), Conflict);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("asn: Meta's fetchers resolve to FACEBOOK; a private or malformed address to nothing", () => {
  assert.ok(asn.load(join(HERE, "..", "asn", "ip2asn-v4.tsv.gz")) > 100000);
  assert.deepEqual(asn.lookup("31.13.24.7"), {asn: 32934, asOrganization: "FACEBOOK"});
  assert.deepEqual(asn.lookup("::ffff:31.13.24.7"), {asn: 32934, asOrganization: "FACEBOOK"});
  assert.deepEqual(asn.lookup("10.0.0.1"), {});
  assert.deepEqual(asn.lookup("not an ip"), {});
  assert.deepEqual(asn.lookup("1.2.3.999"), {});
});
