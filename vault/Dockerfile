# The Vault's image: the Constellation (src/, unchanged) on workerd, Caddy for TLS, keeper as PID 1.
# Every base is pinned by digest and every dependency by package-lock.json, so the same commit
# builds the same image digest -- the digest Confidential Space attests and KMS checks.
FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS caddy

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /vault/vault
COPY vault/package.json vault/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts=false

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=caddy /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# npm is only for building: the running Vault never uses it (it carried every Node CVE the scan found)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=deps /vault/vault/node_modules /vault/vault/node_modules
COPY src /vault/src
COPY vault/workerd.capnp vault/entry.js vault/Caddyfile vault/package.json /vault/vault/
COPY vault/keeper /vault/vault/keeper
COPY vault/envs /vault/vault/envs
COPY vault/asn /vault/vault/asn
# Confidential Space: the operator may choose only which deployment this is (VAULT_ENV), and a
# tmpfs at /data; logs leave the VM only on a debug image
LABEL "tee.launch_policy.allow_env_override"="VAULT_ENV"
LABEL "tee.launch_policy.allow_mount_destinations"="/data"
LABEL "tee.launch_policy.log_redirect"="debugonly"
ENV NODE_ENV=production
EXPOSE 80 443
ENTRYPOINT ["node", "/vault/vault/keeper/keeper.js"]
