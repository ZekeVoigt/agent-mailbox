// Failover: a deployment runs two VMs in two zones. Only the lease holder carries the deployment's
// static IP (the one DNS names); a standby has no public IP at all and reaches Google's APIs
// privately (Private Google Access). So when a Vault takes the lease, it moves the static IP onto
// its own VM -- off the old holder, if that VM still has it -- before it serves. DNS never changes.
import {vmToken} from "./gcp.js";

const META = "http://metadata.google.internal/computeMetadata/v1/";
const API = "https://compute.googleapis.com/compute/v1/";
const meta = async p => (await fetch(META + p, {headers: {"Metadata-Flavor": "Google"}})).text();

async function call(method, path, body) {
  const r = await fetch(API + path, {method, headers: {authorization: `Bearer ${await vmToken()}`,
    "content-type": "application/json"}, body: body ? JSON.stringify(body) : undefined});
  const o = await r.json();
  if (!r.ok) throw new Error(`compute ${method} ${path.split("?")[0]}: ${r.status} ${JSON.stringify(o).slice(0, 300)}`);
  return o;
}
// a resource's URL as a path under API: Compute names resources with either host
const rel = url => url.replace(/^https:\/\/(compute|www)\.googleapis\.com\/compute\/v1\//, "");

async function done(op) {                    // wait for a zonal operation
  for (let i = 0; i < 120 && op.status !== "DONE"; i++) {
    await new Promise(f => setTimeout(f, 1000));
    op = await call("GET", rel(op.selfLink));
  }
  if (op.error) throw new Error(`compute operation: ${JSON.stringify(op.error).slice(0, 300)}`);
  return op;
}

// put `address` (a regional static IP's name) on this VM, retrying (an operation can race the old
// holder's own shutdown); returns what was done, for the log
export async function claim(project, region, address, log = () => {}) {
  for (let i = 1; ; i++) {
    try { return await claimOnce(project, region, address); }
    catch (e) { if (i >= 6) throw e; log(`address: try ${i} failed (${e.message.slice(0, 160)}); again`); await new Promise(f => setTimeout(f, 3000 * i)); }
  }
}
async function claimOnce(project, region, address) {
  const zone = (await meta("instance/zone")).split("/").pop(), name = await meta("instance/name");
  const mine = `projects/${project}/zones/${zone}/instances/${name}`;
  const addr = await call("GET", `projects/${project}/regions/${region}/addresses/${address}`);
  const users = (addr.users || []).map(rel);
  if (users.includes(mine)) return `${addr.address} already on ${name}`;
  for (const other of users) {                // the old holder: take it off
    const vm = await call("GET", other);
    const nic = vm.networkInterfaces[0];
    for (const ac of nic.accessConfigs || [])
      if (ac.natIP === addr.address)
        await done(await call("POST", `${other}/deleteAccessConfig?accessConfig=${encodeURIComponent(ac.name)}&networkInterface=${nic.name}`));
  }
  const me = await call("GET", mine), nic = me.networkInterfaces[0];
  for (const ac of nic.accessConfigs || [])  // a standby should have none; drop any ephemeral one
    await done(await call("POST", `${mine}/deleteAccessConfig?accessConfig=${encodeURIComponent(ac.name)}&networkInterface=${nic.name}`));
  await done(await call("POST", `${mine}/addAccessConfig?networkInterface=${nic.name}`,
    {name: "vault-address", type: "ONE_TO_ONE_NAT", natIP: addr.address}));
  return `${addr.address} moved to ${name}${users.length ? ` from ${users.map(u => u.split("/").pop()).join(", ")}` : ""}`;
}

// on the way out (keeper's SIGTERM path, after the lease is released): let go of the static IP at
// once, so the next holder need not wait for this VM to finish stopping. Not waited for: the call
// takes this VM's own public IP away, and with it this request's way back.
export async function release(project, region, address) {
  const zone = (await meta("instance/zone")).split("/").pop(), name = await meta("instance/name");
  const mine = `projects/${project}/zones/${zone}/instances/${name}`;
  const addr = await call("GET", `projects/${project}/regions/${region}/addresses/${address}`);
  if (!(addr.users || []).map(rel).includes(mine)) return "not held";
  const nic = (await call("GET", mine)).networkInterfaces[0];
  for (const ac of nic.accessConfigs || [])
    if (ac.natIP === addr.address)
      await call("POST", `${mine}/deleteAccessConfig?accessConfig=${encodeURIComponent(ac.name)}&networkInterface=${nic.name}`);
  return `${addr.address} let go`;
}
