// One writer at a time: a Vault serves only while it holds the `lease` object, renewed every 10 s
// with a generation-matched write. Two Vaults on one bucket (a deploy's old and new VM) never both
// write: the new one waits until the old one releases the lease or lets it lapse.
import {randomUUID} from "node:crypto";
import {hostname} from "node:os";
import {Conflict} from "./store.js";

const NAME = "lease", TTL = 45e3, EVERY = 10e3;

export class Lease {
  constructor(store, log, onLost) {
    Object.assign(this, {store, log, onLost});
    this.me = randomUUID();
    this.gen = null; this.ok = 0; this.timer = null;
  }
  body() { return Buffer.from(JSON.stringify({holder: this.me, until: Date.now() + TTL})); }

  async acquire() {
    for (let said = false; ; ) {
      const h = await this.store.head(NAME);
      try {
        if (!h) { this.gen = (await this.store.put(NAME, this.body(), 0)).generation; break; }
        const cur = JSON.parse((await this.store.get(NAME)).toString());
        if (cur.holder === this.me || cur.until < Date.now()) {
          this.gen = (await this.store.put(NAME, this.body(), h.generation)).generation;
          break;
        }
        if (!said) { this.log(`lease: held by another Vault until ${new Date(cur.until).toISOString()}; waiting`); said = true; }
        // say so: vault/deploy hands over only once the standby it restarted is ready (standby/<host>)
        await this.store.put(`standby/${hostname()}`, Buffer.from(JSON.stringify({at: Date.now()}))).catch(() => {});
        // look again every 5 s: a holder that stops cleanly releases the lease at once
        await new Promise(f => setTimeout(f, Math.min(Math.max(cur.until - Date.now(), 0) + 1000, 5e3)));
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;   // another took it first: look again
      }
    }
    this.ok = Date.now(); this.wasHeld = true;
    this.log("lease: held");
    this.timer = setInterval(() => this.renew().catch(e => this.log(`lease: renew failed: ${e.message}`)), EVERY);
  }

  async renew() {
    if (this.gen === null) return;
    try {
      this.gen = (await this.store.put(NAME, this.body(), this.gen)).generation;
      this.ok = Date.now();
    } catch (e) {
      if (e instanceof Conflict) return this.lose("another Vault took the lease");
      if (Date.now() - this.ok > TTL - 5e3) return this.lose("could not renew the lease in time");
      throw e;
    }
  }
  held() { return this.gen !== null && Date.now() - this.ok < TTL - 5e3; }
  lose(why) {
    if (this.gen === null) return;
    this.gen = null; clearInterval(this.timer);
    this.log(`lease: LOST (${why}); stopping`);
    this.onLost(why);
  }
  async release() {
    clearInterval(this.timer);
    if (this.gen === null) return;
    try { await this.store.del(NAME, this.gen); this.log("lease: released"); } catch (e) { this.log(`lease: release failed: ${e.message}`); }
    this.gen = null;
  }
}
