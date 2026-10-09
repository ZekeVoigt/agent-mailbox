// An IPv4 address -> its network (asn, asOrganization), what Cloudflare put on request.cf: the app
// pins a chatbot's link to the network its maker fetches from. The table is iptoasn.com's
// ip2asn-v4 (PDDL), pinned in the image by vault/asn/SHA256.
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";

let starts, ends, asns, orgs;

export function load(path) {
  const rows = gunzipSync(readFileSync(path)).toString().split("\n");
  starts = new Uint32Array(rows.length); ends = new Uint32Array(rows.length);
  asns = new Uint32Array(rows.length); orgs = new Array(rows.length);
  let n = 0;
  for (const line of rows) {
    const [a, b, asn, , org] = line.split("\t");
    if (!org || asn === "0") continue;
    starts[n] = v4(a); ends[n] = v4(b); asns[n] = +asn; orgs[n] = org; n++;
  }
  starts = starts.subarray(0, n); ends = ends.subarray(0, n); asns = asns.subarray(0, n);
  return n;
}

function v4(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return -1;
  let x = 0;
  for (const s of p) { const k = +s; if (!/^\d{1,3}$/.test(s) || k > 255) return -1; x = x * 256 + k; }
  return x;
}

export function lookup(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip || "");
  const x = v4(m ? m[1] : ip || "");
  if (x < 0 || !starts) return {};
  let lo = 0, hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= x) lo = mid + 1; else hi = mid - 1;
  }
  return hi >= 0 && x <= ends[hi] ? {asn: asns[hi], asOrganization: orgs[hi]} : {};
}
