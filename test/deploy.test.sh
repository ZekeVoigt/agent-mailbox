#!/bin/sh
# scripts/deploy's refusals and its one way through, against a private worker (never production):
#
#   DEPLOY_CONFIG=<its wrangler config> DEPLOY_URL=<its URL> CLERK_SECRET_KEY=... ADMIN=... \
#     ADMIN_OWNER=... sh test/deploy.test.sh
#
# Run from a clean tree. It deploys the private worker several times, once through the whole e2e.
set -u
cd "$(dirname "$0")/.."
: "${DEPLOY_CONFIG:?}" "${DEPLOY_URL:?}"
unset CLOUDFLARE_API_TOKEN
export DEPLOY_LOCK="${TMPDIR:-/tmp}/constellation-deploy-test.lock" DEPLOY_SETTLE_S=10
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
# expect <what> <words the refusal must contain> <command...>: refused, saying so
expect_refused() {
  what=$1 words=$2; shift 2
  out=$("$@" 2>&1) && { fail "$what (it deployed)"; echo "$out" | tail -3; return; }
  echo "$out" | grep -q "$words" && pass "$what" || { fail "$what"; echo "$out" | tail -3; }
}
raw_deploy() { npx wrangler deploy -c "$DEPLOY_CONFIG" --message "$1" >/dev/null 2>&1; }
sha=$(git rev-parse HEAD)
passed="$(git rev-parse --git-common-dir)/deploy-e2e"
rm -f "$passed/$sha"

touch deploy-test-dirty
expect_refused "a working tree with changes is refused" "working tree has changes" scripts/deploy staging
rm -f deploy-test-dirty

raw_deploy "by hand"
expect_refused "a live version with no commit recorded must be named" "DEPLOY_OVER=" scripts/deploy staging

raw_deploy "git:0123456789abcdef0123456789abcdef01234567"
expect_refused "a live commit this clone does not have is refused" "does not have" scripts/deploy staging

other=$(git commit-tree "HEAD^{tree}" -p HEAD -m "someone else's deploy")
raw_deploy "git:$other"
expect_refused "a live commit this one does not contain is refused" "merge it first" scripts/deploy staging

raw_deploy "git:$sha"
expect_refused "production before staging passed is refused" "has not passed" scripts/deploy production

mkdir -p "$DEPLOY_LOCK"; sleep 300 & echo $! > "$DEPLOY_LOCK/pid"; holder=$!
expect_refused "a second deploy while one runs is refused" "another deploy is running" scripts/deploy staging
kill $holder 2>/dev/null; wait $holder 2>/dev/null
pass "(the first deploy's process ends, leaving its lock behind)"

if scripts/deploy staging > deploy-test.log 2>&1 && grep -q "staging passed" deploy-test.log; then
  pass "a dead deploy's lock is taken over; staging deployed, read back, its e2e passed and recorded"
else fail "staging"; tail -5 deploy-test.log; fi
grep -q "ALL PASS" deploy-test.log && pass "(the whole e2e ran: $(grep -c '^PASS' deploy-test.log) checks)" || fail "the e2e did not run whole"
rm -f deploy-test.log
[ -f "$passed/$sha" ] && pass "the pass is recorded for this exact commit" || fail "no pass recorded"

out=$(scripts/deploy production 2>&1) && echo "$out" | grep -q "runs .* (git:" &&
  pass "production: a passed commit on top of the live one deploys, and is read back live" ||
  { fail "production"; echo "$out" | tail -3; }
[ ! -d "$DEPLOY_LOCK" ] && pass "the lock is released" || fail "the lock is left behind"
[ $fails = 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
