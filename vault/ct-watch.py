#!/usr/bin/env python3
"""Every certificate the public Certificate Transparency logs show for a Vault's host must be one
the Vault made itself (/attestation/certs). Anything else is a certificate someone else got for the
host -- with DNS, the operator could -- and is reported. Exit 1 if there is one.

    python3 vault/ct-watch.py https://agents.ai-andromeda.com [--since 2026-10-10]

--since: ignore certificates that started before the Vault served this host (Cloudflare's, before
the cutover). Uses crt.sh's public JSON; Python's standard library only.
"""
import argparse, json, sys, time, urllib.parse, urllib.request


def get(url, tries=4):
    for i in range(tries):          # crt.sh is often slow or busy: a failure to look is not an alert
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vault-ct-watch"}), timeout=90) as r:
                return json.loads(r.read())
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(20 * (i + 1))


def serial(s):
    return s.replace(":", "").lower().lstrip("0")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--since", default="", help="YYYY-MM-DD: ignore certificates valid from before this")
    a = ap.parse_args()
    host = urllib.parse.urlparse(a.url).hostname
    made = {serial(c["serial"]) for c in get(f"https://{host}/attestation/certs")["certificates"]}
    seen = get("https://crt.sh/?" + urllib.parse.urlencode({"q": host, "output": "json"}))
    strange = {}
    for c in seen:
        if a.since and c["not_before"][:10] < a.since:
            continue
        if host not in c.get("name_value", "").split("\n"):
            continue
        s = serial(c["serial_number"])
        if s not in made:
            strange[s] = c
    print(f"{host}: the Vault made {len(made)} certificate(s); CT shows {len(seen)} entries")
    for s, c in strange.items():
        print(f"NOT THE VAULT'S: serial {s}, issuer {c['issuer_name']}, from {c['not_before']} (crt.sh id {c['id']})")
    print("ok: every certificate in CT is the Vault's" if not strange else f"ALERT: {len(strange)} certificate(s) the Vault did not make")
    return 1 if strange else 0


if __name__ == "__main__":
    sys.exit(main())
