#!/usr/bin/env python3
"""Check, from anywhere, that a Constellation Vault is the sealed code it claims to be.

    python3 vault/verify.py https://agents.ai-andromeda.com [--digest sha256:...] [--digests vault/DIGESTS]

Python's standard library only. It:
  1. connects over TLS and keeps the certificate the server presented;
  2. asks /attestation for a fresh token carrying a random nonce of its own;
  3. checks the token's RS256 signature against Google Confidential Computing's published keys,
     its issuer, audience (this host), expiry, and that it carries the nonce;
  4. checks it describes a Confidential Space VM on AMD SEV or Intel TDX with secure boot, the
     production (non-debug) image unless --allow-debug, and prints the container image digest;
  5. checks the token names the SHA-256 of the very certificate from step 1 -- keeper adds it --
     so the TLS key you are talking to is held inside the attested code, not by a proxy in front;
  6. with --digest, that the digest is that one; with --digests, that it is in the public list.
Exit 0 only if every check passes.
"""
import argparse, base64, hashlib, json, secrets, socket, ssl, sys, time, urllib.parse, urllib.request

ISS = "https://confidentialcomputing.googleapis.com"


def b64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rs256_ok(jwk, signing_input, sig):
    """RSASSA-PKCS1-v1_5 with SHA-256, by hand (RFC 8017 8.2.2): no third-party crypto needed."""
    n, e = int.from_bytes(b64u(jwk["n"]), "big"), int.from_bytes(b64u(jwk["e"]), "big")
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
    info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(signing_input).digest()
    return em == b"\x00\x01" + b"\xff" * (k - len(info) - 3) + b"\x00" + info


def fetch(url, ctx):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vault-verify"}),
                                timeout=30, context=ctx) as r:
        return r.read().decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--digest", help="require this image digest")
    ap.add_argument("--digests", help="require the digest to be listed in this file (vault/DIGESTS)")
    ap.add_argument("--allow-debug", action="store_true", help="accept a debug image (staging)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    say = (lambda *x: None) if a.quiet else print
    u = urllib.parse.urlparse(a.url)
    host, port = u.hostname, u.port or 443
    ctx = ssl.create_default_context()
    fails = []

    def check(ok, what):
        say(("ok    " if ok else "FAIL  ") + what)
        if not ok:
            fails.append(what)

    # 1. the certificate this server presents
    with socket.create_connection((host, port), timeout=20) as s, ctx.wrap_socket(s, server_hostname=host) as t:
        cert = t.getpeercert(binary_form=True)
    cert_hash = hashlib.sha256(cert).hexdigest()
    say(f"certificate sha256 {cert_hash}")

    # 2. a fresh token, with our nonce
    nonce = secrets.token_urlsafe(24)
    token = fetch(f"https://{host}:{port}/attestation?nonce={nonce}", ctx).strip()
    h, p, sig = token.split(".")
    head, claims = json.loads(b64u(h)), json.loads(b64u(p))

    # 3. Google's signature, issuer, audience, time, nonce
    conf = json.loads(fetch(ISS + "/.well-known/openid-configuration", ssl.create_default_context()))
    keys = json.loads(fetch(conf["jwks_uri"], ssl.create_default_context()))["keys"]
    jwk = next((k for k in keys if k.get("kid") == head.get("kid")), None)
    check(head.get("alg") == "RS256" and jwk is not None and rs256_ok(jwk, f"{h}.{p}".encode(), b64u(sig)),
          "signed by Google Confidential Computing")
    check(claims.get("iss") == ISS, f"issuer {claims.get('iss')}")
    aud = claims.get("aud")
    check(aud == f"https://{host}" or (isinstance(aud, list) and f"https://{host}" in aud), f"audience {aud}")
    now = time.time()
    check(claims.get("nbf", 0) <= now + 60 and claims.get("exp", 0) > now, "within its validity")
    nonces = claims.get("eat_nonce")
    nonces = [nonces] if isinstance(nonces, str) else (nonces or [])
    check(nonce in nonces, "carries our fresh nonce")

    # 4. what is running
    sub = claims.get("submods", {})
    cont = sub.get("container", {})
    check(claims.get("swname") == "CONFIDENTIAL_SPACE", f"software {claims.get('swname')}")
    check(claims.get("hwmodel") in ("GCP_AMD_SEV", "GCP_AMD_SEV_ES", "GCP_AMD_SEV_SNP", "GCP_INTEL_TDX"),
          f"hardware {claims.get('hwmodel')} (memory encrypted by the CPU)")
    check(claims.get("secboot") is True, "secure boot")
    dbg = claims.get("dbgstat")
    check(dbg == "disabled-since-boot" or a.allow_debug, f"debug {dbg} (a debug image sends its logs out)")
    digest = cont.get("image_digest", "")
    say(f"image {cont.get('image_reference', '')}")
    say(f"digest {digest}   VAULT_ENV={(cont.get('env_override') or {}).get('VAULT_ENV')}")

    # 5. the TLS key is the enclave's
    check(cert_hash in nonces, "the certificate you connected to is the one the attested code holds")

    # 6. the digest
    if a.digest:
        check(digest == a.digest, f"digest is {a.digest}")
    if a.digests:
        listed = {line.split()[-1] for line in open(a.digests) if line.strip() and not line.startswith("#")}
        check(digest in listed, f"digest is in {a.digests}")
    say("VERIFIED" if not fails else f"NOT VERIFIED: {len(fails)} check(s) failed")
    return 0 if not fails else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"NOT VERIFIED: {e}", file=sys.stderr)
        sys.exit(1)
