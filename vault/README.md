# The Vault

The sealed Constellation: src/ on workerd, inside a GCP Confidential Space VM. Why and how:
PLAN.md. What it protects and what it doesn't: ../SECURITY.md.

| File | What it is |
|---|---|
| `entry.js` | wraps src/index.js: `request.cf`, the rate limits, MEDIA, the cron, keeper's internal routes |
| `workerd.capnp` | workerd's config (part of the attested image; secrets arrive as environment) |
| `Caddyfile` | TLS inside the VM; `/attestation`, `/attestation/certs` and `/admin/restore` go to keeper |
| `keeper/` | PID 1: the lease, the KMS-wrapped data key, snapshots, media, attestation, the restore |
| `envs/*.json` | one per deployment (`VAULT_ENV`): host, bucket, KMS key, attestation pool, vars, secrets |
| `asn/` | iptoasn.com's ip2asn-v4 (PDDL), for `request.cf.asOrganization` |
| `deploy` | the only release path (reproducible build, KMS per digest, DIGESTS, restart, revoke) |
| `verify.py` | anyone's check of a live Vault (stdlib only) |
| `ct-watch.py` | Certificate Transparency vs the certificates the Vault made |
| `DIGESTS` | every image digest ever allowed to unwrap a data key -- the public record |

## Run it locally

```sh
cd vault && npm ci && npm test                       # keeper's own tests
cd .. && docker build -f vault/Dockerfile -t vault:local .
mkdir -p ~/.cache/vault-local-store                   # under $HOME: Colima mounts nothing else
docker run -d --name vault-local -e VAULT_ENV=local \
  -e CLERK_SECRET_KEY=sk_test_... -e ADMIN=... -e ADMIN_OWNER=... \
  --tmpfs /data:rw,size=512m -v ~/.cache/vault-local-store:/store -p 8443:443 vault:local
docker exec vault-local cat /data/caddy/pki/authorities/local/root.crt > /tmp/vault-root.crt
cat /etc/ssl/cert.pem /tmp/vault-root.crt > /tmp/vault-bundle.pem
SSL_CERT_FILE=/tmp/vault-bundle.pem E2E_TEST_SITE=1 E2E_LINKS_MIGRATED=1 \
  CLERK_SECRET_KEY=... ADMIN=... ADMIN_OWNER=... python3 test/e2e.py https://localhost:8443
```

`VAULT_ENV=local` keeps its key in the store directory: it is for development only, and keeper
refuses it inside a Confidential Space VM. Give Clerk's API a few minutes between e2e runs: it
rate-limits the user churn, and an e2e account it cannot read counts as a real signup.

## Release

`vault/deploy staging`, the e2e against https://vault-test.ai-andromeda.com, then
`vault/deploy production`; commit `vault/DIGESTS` after each. `DEBUG=1` boots staging on the debug
image (its logs reach the serial console and Cloud Logging); production refuses it.

## Check it

```sh
python3 vault/verify.py https://agents.ai-andromeda.com --digests vault/DIGESTS
python3 vault/ct-watch.py https://agents.ai-andromeda.com --since <the cutover date>
```
