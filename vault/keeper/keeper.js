// keeper: the Vault's supervisor, the container's first process.
//   1. takes the lease (one Vault writes at a time);
//   2. gets the data key: unwrapped by Cloud KMS, which answers only an attested image;
//   3. restores the newest snapshot into the tmpfs;
//   4. starts workerd (the Constellation) and Caddy (TLS, its key made here);
//   5. snapshots every SNAP_EVERY, collects old snapshots hourly, runs the app's hourly cron;
//   6. on SIGTERM: Caddy stops taking requests, workerd stops, a last snapshot, the lease released.
// It also serves, on loopback only: the ASN table and the media store to workerd, and /attestation,
// which Caddy passes through from the internet.
import http from "node:http";
import {spawn} from "node:child_process";
import {readFileSync, existsSync, writeFileSync, mkdirSync} from "node:fs";
import {randomBytes} from "node:crypto";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {Gcs, Local, Conflict} from "./store.js";
import {Lease} from "./lease.js";
import {Snapshots} from "./snap.js";
import {blobs, send} from "./blobs.js";
import {derive} from "./crypto.js";
import * as asn from "./asn.js";
import * as gcp from "./gcp.js";

const HERE = dirname(fileURLToPath(import.meta.url)), VAULT = join(HERE, "..");
const ENV = process.env.VAULT_ENV || "local";
if (!/^[a-z]+$/.test(ENV) || !existsSync(join(VAULT, "envs", ENV + ".json"))) { console.error(`unknown VAULT_ENV ${ENV}`); process.exit(2); }
const conf = JSON.parse(readFileSync(join(VAULT, "envs", ENV + ".json")));
const DATA = process.env.VAULT_DATA || "/data";
const ROOTS = {do: join(DATA, "do"), caddy: join(DATA, "caddy")};   // Caddyfile: storage {$VAULT_DATA}/caddy
const SNAP_EVERY = Number(process.env.VAULT_SNAP_EVERY_S || 15) * 1000;
const log = s => console.log(`keeper ${new Date().toISOString()} ${s}`);

let workerd = null, caddy = null, stopping = false, lease = null, snaps = null, frozen = false;

// -- the data key ------------------------------------------------------------------------------
async function dataKey(store) {
  if (conf.keyFile) {                  // local runs only: a key on disk
    if (!existsSync(conf.keyFile)) { mkdirSync(dirname(conf.keyFile), {recursive: true}); writeFileSync(conf.keyFile, randomBytes(32), {mode: 0o600}); }
    return readFileSync(conf.keyFile);
  }
  const token = gcp.workloadToken(conf.provider);
  for (;;) {
    const wrapped = await store.get("key/data.wrapped");
    if (wrapped) return gcp.kms(token, conf.kmsKey, "decrypt", "ciphertext", wrapped);
    const fresh = randomBytes(32);
    try {
      await store.put("key/data.wrapped", await gcp.kms(token, conf.kmsKey, "encrypt", "plaintext", fresh), 0);
      log("key: a new data key was made and stored wrapped");
      return fresh;
    } catch (e) { if (!(e instanceof Conflict)) throw e; }   // another Vault made one first: use that
  }
}

// -- workerd, frozen for a snapshot's copy ------------------------------------------------------
async function freeze(fn) {
  if (!workerd || workerd.exitCode !== null) return fn();
  frozen = true;
  workerd.kill("SIGSTOP");
  try { return await fn(); } finally { workerd.kill("SIGCONT"); frozen = false; }
}

async function secrets() {
  const out = {};
  for (const [k, v] of Object.entries(conf.secrets || {})) out[k] = await gcp.secret(v);
  for (const k of conf.secretsFromEnv || []) if (process.env[k]) out[k] = process.env[k];
  return out;
}

function start(cmd, args, env, name) {
  const p = spawn(cmd, args, {env, stdio: ["ignore", "inherit", "inherit"]});
  p.on("exit", (code, sig) => { if (!stopping) { log(`${name} exited (${code ?? sig}); stopping`); shutdown(1); } });
  return p;
}

async function waitFor(port, path, headers = {}) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}${path}`, {headers}); return; } catch { await new Promise(f => setTimeout(f, 100)); }
  }
  throw new Error(`nothing answered on ${port}`);
}

// -- /attestation: Google's signed token for this exact image, with the caller's nonce if given
let attCache = null, nonced = [];
async function attestation(url, res) {
  if (!existsSync(gcp.TEE_SOCK)) return send(res, 503, "No attestation here: this is not a Confidential Space VM.\n", {"content-type": "text/plain"});
  const nonce = url.searchParams.get("nonce");
  if (nonce !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return send(res, 400, "A nonce is 8 to 64 characters of A-Z a-z 0-9 _ -.\n");
  try {
    if (nonce) {
      nonced = nonced.filter(t => t > Date.now() - 60e3);
      if (nonced.length >= 20) return send(res, 429, "Too many fresh tokens this minute: try again shortly.\n");
      nonced.push(Date.now());
      return send(res, 200, await gcp.teeToken(`https://${conf.host}`, [nonce]) + "\n", {"content-type": "text/plain", "cache-control": "no-store"});
    }
    if (!attCache || attCache.at < Date.now() - 600e3) attCache = {at: Date.now(), t: await gcp.teeToken(`https://${conf.host}`)};
    return send(res, 200, attCache.t + "\n", {"content-type": "text/plain", "cache-control": "no-store"});
  } catch (e) {
    log(`attestation: ${e.message}`);
    return send(res, 503, "The attestation service did not answer: try again in a minute.\n");
  }
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log("stopping");
  const gone = p => p && p.exitCode === null && p.signalCode === null ? new Promise(f => { p.once("exit", f); }) : Promise.resolve();
  if (caddy) { caddy.kill("SIGTERM"); await Promise.race([gone(caddy), new Promise(f => setTimeout(f, 5000))]); }
  if (workerd) {
    if (frozen) workerd.kill("SIGCONT");
    workerd.kill("SIGTERM");
    await Promise.race([gone(workerd), new Promise(f => setTimeout(f, 5000))]);
    if (workerd.exitCode === null && workerd.signalCode === null) { workerd.kill("SIGKILL"); await gone(workerd); }
  }
  try { if (snaps && lease && lease.held()) { const s = await snaps.take(true); log(`last snapshot: ${s || "nothing new"}`); } }
  catch (e) { log(`last snapshot failed: ${e.message}`); code = code || 1; }
  if (lease) await lease.release();
  process.exit(code);
}

// inside a Confidential Space VM, plaintext must never reach a disk: the state lives on a tmpfs,
// and the key and the store are the attested ones (a local key file would sit beside its ciphertext)
function refuseUnsealed() {
  if (!existsSync(gcp.TEE_SOCK)) return;
  const mounts = readFileSync("/proc/mounts", "utf8").split("\n").map(l => l.split(" "));
  if (!mounts.some(m => m[1] === DATA && m[2] === "tmpfs")) throw new Error(`${DATA} is not a tmpfs: refusing to start`);
  if (conf.keyFile || conf.store.local || (conf.secretsFromEnv || []).length) throw new Error(`VAULT_ENV=${ENV} is for local runs only`);
}

async function main() {
  log(`starting (${ENV}, ${conf.host})`);
  refuseUnsealed();
  const store = conf.store.local ? new Local(conf.store.local) : new Gcs(conf.store.bucket, gcp.vmToken);
  lease = new Lease(store, log, () => { if (!stopping) { stopping = true; workerd?.kill("SIGKILL"); caddy?.kill("SIGKILL"); process.exit(3); } });
  await lease.acquire();
  const dk = await dataKey(store);
  const keys = {box: derive(dk, "snapshot"), mac: derive(dk, "mac"), media: derive(dk, "media")};
  dk.fill(0);
  snaps = new Snapshots({store, keys, roots: ROOTS, freeze, held: () => lease.held(), log});
  for (const d of Object.values(ROOTS)) mkdirSync(d, {recursive: true});
  await snaps.restore();
  log(`asn: ${asn.load(join(VAULT, "asn", "ip2asn-v4.tsv.gz"))} ranges`);

  const media = blobs({store, keys, tmp: join(DATA, "tmp")});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://keeper");
    try {
      if (url.pathname === "/attestation" && req.method === "GET") return await attestation(url, res);
      if (url.pathname === "/asn") return send(res, 200, JSON.stringify(asn.lookup(url.searchParams.get("ip"))), {"content-type": "application/json"});
      if (url.pathname.startsWith("/blob")) return await media(req, res, url);
      send(res, 404, "");
    } catch (e) {
      log(`keeper ${req.method} ${url.pathname.split("/").slice(0, 2).join("/")}: ${e.message}`);
      send(res, 500, "");
    }
  });
  await new Promise(f => server.listen(8081, "127.0.0.1", f));

  const internal = randomBytes(24).toString("hex");
  // workerd verifies TLS (Clerk, GIPHY) against the CA bundle the image copies from Caddy's
  const env = {PATH: process.env.PATH, HOME: process.env.HOME || "/tmp", VAULT_INTERNAL: internal,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE || "/etc/ssl/certs/ca-certificates.crt",
    ...conf.vars, ...(await secrets())};
  workerd = start(conf.workerd || join(VAULT, "node_modules", ".bin", "workerd"),
    ["serve", join(VAULT, "workerd.capnp"), "--directory-path", `do-disk=${ROOTS.do}`], env, "workerd");
  await waitFor(8080, "/.well-known/security.txt");
  caddy = start(conf.caddy || "caddy", ["run", "--config", join(VAULT, "Caddyfile"), "--adapter", "caddyfile"],
    {PATH: process.env.PATH, HOME: process.env.HOME || "/tmp", VAULT_HOST: conf.host, VAULT_DATA: DATA,
      XDG_CONFIG_HOME: join(DATA, "caddy-config"), ...(conf.caddyEnv || {})}, "caddy");
  log("serving");

  setInterval(() => {
    if (stopping) return;
    snaps.take().then(s => s && log(`snapshot ${s}`), e => log(`snapshot failed: ${e.message}`));
  }, SNAP_EVERY);
  setInterval(() => { if (!stopping) snaps.gc().then(r => (r.manifests || r.blobs) && log(`gc: ${JSON.stringify(r)}`), e => log(`gc failed: ${e.message}`)); }, 3600e3);
  // the app's cron ("17 * * * *"): checked every minute, run once in minute 17 of each hour
  let ran = -1;
  setInterval(() => {
    const d = new Date();
    if (stopping || d.getUTCMinutes() !== 17 || ran === d.getUTCHours()) return;
    ran = d.getUTCHours();
    fetch("http://127.0.0.1:8080/__vault/scheduled", {method: "POST", headers: {"x-vault-internal": internal}})
      .catch(e => log(`cron failed: ${e.message}`));
  }, 30e3);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
main().catch(e => { log(`fatal: ${e.stack || e.message}`); shutdown(1); });
