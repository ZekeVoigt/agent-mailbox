# workerd's configuration inside the Vault. Part of the attested image: nothing here is secret.
# Secrets and the deployment's own values arrive as environment variables that keeper sets
# (`fromEnvironment`), read by keeper from Secret Manager and vault/envs/<VAULT_ENV>.json.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .constellation),
    # Durable Object storage: on a tmpfs, so no plaintext ever reaches a disk
    (name = "do-disk", disk = (path = "/data/do", writable = true)),
    # keeper: the ASN table and the encrypted media store, on loopback only
    (name = "keeper", external = (address = "127.0.0.1:8081", http = ())),
    # what the app may fetch: Clerk, GIPHY -- public addresses only, never this machine's
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    # behind Caddy, which ends TLS: the scheme is taken from X-Forwarded-Proto
    (name = "http", address = "127.0.0.1:8080", service = "main",
     http = (forwardedProtoHeader = "X-Forwarded-Proto")),
  ],
);

const constellation :Workerd.Worker = (
  modules = [
    (name = "entry.js", esModule = embed "entry.js"),
    (name = "src/index.js", esModule = embed "../src/index.js"),
    (name = "src/ui.js", esModule = embed "../src/ui.js"),
    (name = "src/auth.js", esModule = embed "../src/auth.js"),
    (name = "src/box.js", esModule = embed "../src/box.js"),
    (name = "src/look.js", esModule = embed "../src/look.js"),
    (name = "src/passkey.js", esModule = embed "../src/passkey.js"),
    (name = "src/a2a.js", esModule = embed "../src/a2a.js"),
  ],
  compatibilityDate = "2026-10-01",
  bindings = [
    (name = "DIR", durableObjectNamespace = "Directory"),
    (name = "AGENT", durableObjectNamespace = "Agent"),
    (name = "LEDGER", durableObjectNamespace = "Ledger"),
    (name = "LINK", durableObjectNamespace = "LinkRef"),
    (name = "BOX", durableObjectNamespace = "Box"),
    (name = "KEEPER", service = "keeper"),
    (name = "VAULT_INTERNAL", fromEnvironment = "VAULT_INTERNAL"),
    # the deployment's values (vault/envs/*.json)
    (name = "LOCK_MODE", fromEnvironment = "LOCK_MODE"),
    (name = "LINK_UNUSED_TTL_S", fromEnvironment = "LINK_UNUSED_TTL_S"),
    (name = "AGENTS_OFFERED", fromEnvironment = "AGENTS_OFFERED"),
    (name = "CLERK_FAPI", fromEnvironment = "CLERK_FAPI"),
    (name = "CLERK_PK", fromEnvironment = "CLERK_PK"),
    (name = "TEST_SITE", fromEnvironment = "TEST_SITE"),
    (name = "LINKS_MIGRATED", fromEnvironment = "LINKS_MIGRATED"),
    (name = "INVITE_ONLY", fromEnvironment = "INVITE_ONLY"),
    (name = "MESSAGES_PER_DAY", fromEnvironment = "MESSAGES_PER_DAY"),
    (name = "SIGNUPS_PER_IP", fromEnvironment = "SIGNUPS_PER_IP"),
    (name = "UNPOSTED_LIFE_S", fromEnvironment = "UNPOSTED_LIFE_S"),
    # secrets (Secret Manager)
    (name = "CLERK_SECRET_KEY", fromEnvironment = "CLERK_SECRET_KEY"),
    (name = "ADMIN", fromEnvironment = "ADMIN"),
    (name = "ADMIN_OWNER", fromEnvironment = "ADMIN_OWNER"),
    (name = "GIPHY_KEY", fromEnvironment = "GIPHY_KEY"),
  ],
  durableObjectNamespaces = [
    (className = "Directory", uniqueKey = "constellation-directory", enableSql = true),
    (className = "Agent", uniqueKey = "constellation-agent", enableSql = true),
    (className = "Ledger", uniqueKey = "constellation-ledger", enableSql = true),
    (className = "LinkRef", uniqueKey = "constellation-linkref", enableSql = true),
    (className = "Box", uniqueKey = "constellation-box", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "internet",
);
