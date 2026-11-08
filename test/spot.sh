#!/usr/bin/env bash
# A name two zones keep apart, end to end against a fake provider.
#
#   bash test/spot.sh
#
# The 2026-10-14 accident, held so it cannot happen again. `database-url`
# is declared at the root (production) and again under `zone moon` (the
# development pool). `zone save --name database-url --zone moon --commit`
# was run: `--zone` is not a flag, it was ignored, the save picked a zone
# by a silent rule, and the writer overwrote every copy under the key,
# production's included. Held here:
#
#   an unknown flag is refused, naming it and the real ones, on save,
#     read, toss and load, before the provider is touched
#   a name declared in two zones is refused without --spot, and the
#     refusal lists each zone with its exact command
#   the report (no --commit) names the zone the value goes to, every
#     zone that reads it, and the zones it leaves alone
#   a --spot save to moon creates moon's own copy and leaves production's
#     value and note byte for byte, and a second one updates moon's alone
#   a root save leaves the moon override untouched
#   each zone's `zone load` sees its own value
#   --spot naming a zone that does not declare the name is refused
#   toss, read and hook are scoped the same way
#
# Headless. The fake bws (test/fake.sh) persists to $ZONE_FAKE_STORE so a
# save and a load, two processes, see one provider. No keychain, no network.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
. "$HERE/term.sh"
zone_term_find "$ZONE" || exit 1
WORK="$(zone_work)"
PROJ="$WORK/proj"
SBOX="$WORK/home"
mkdir -p "$PROJ" "$SBOX/.base/@term/zone"

cleanup(){ rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok(){ printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
strip(){ grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script'; }

cat > "$PROJ/zone.tree" <<'TREE'
self true

base bitwarden
  bind organization, <00000000-0000-0000-0000-000000000000>
  bind mode, note
  bind project, <base>

need database-url
need api-key

zone moon
  want database-url

zone site
  zone home
TREE

cat > "$SBOX/.base/@term/zone/zone.tree" <<'EOF2'
mind lance
host spotbox
team cluesurf
sort moon
save env
EOF2

# Production's copy exists. Moon's override does not yet, exactly as on
# the night: the first moon save is a create.
. "$HERE/fake.sh"
zone_fake "$ZONE" "$WORK" || { echo "could not set up the fake bws"; exit 1; }
cat > "$ZONE_FAKE_STORE" <<'EOF3'
[
  { "id": "s-1", "key": "database-url", "value": "PROD", "note": "list zone, <base>", "projectId": "p-base" },
  { "id": "s-2", "key": "api-key", "value": "KEY", "note": "list zone, <base>", "projectId": "p-base" }
]
EOF3

export HOME="$SBOX"
export TERM_CACHE_HOME="$SBOX/.cache"
export ZONE_SAVE=env
export ZONE_CODE=fake-machine-token

(cd "$ZONE" && pnpm exec tsx test/make-key.ts "$WORK/key" >/dev/null 2>&1)
export ZONE_LOCK="$(cat "$WORK/key")"

# ZONE_BUILT=1 runs the prebuilt shape instead: `call/zone.mjs` over a
# built `host/line` console, with node alone and no Term CLI.
#
# BUILT HERE, from the copy `zone_fake` made, OUT OF THE CHECKOUT. The
# package's own `host/line` carries the real pin, so it would refuse the fake
# bws, and a bundle run inside the checkout resolves its `require` against
# the checkout's node_modules, which is not what an install sees.
if [ "${ZONE_BUILT:-}" = "1" ]; then
  ( cd "$ZONE_SRC" && node "$TERM_HOST" boot code/line/base.tree --out host/line >/dev/null 2>&1 ) \
    || { echo "could not build host/line from the copy"; exit 1; }
  zone(){ ( cd "$PROJ" && node "$ZONE_SRC/call/zone.mjs" "$@" 2>&1 | strip ); }
else
  zone(){ ( cd "$PROJ" && node "$TERM_HOST" boot "$ZONE_SRC/code/line/base.tree" -- "$@" 2>&1 | strip ); }
fi
calls(){ wc -l < "$ZONE_FAKE_LOG" | tr -d ' '; }
writes(){ grep -cE 'secret (create|update|delete)' "$ZONE_FAKE_LOG"; }
seen(){ zone load "${2:-base}" -- node -e "process.stdout.write(JSON.stringify(process.env.$1 ?? null))" 2>/dev/null | tail -1; }
# One copy's field, by its note, read from the fake store. Values here are
# test strings, never real secrets.
field(){ node -e '
  const all = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const one = all.filter(s => s.key === process.argv[2] && s.note.includes("<" + process.argv[3] + ">"))
  process.stdout.write(one.length === 1 ? String(one[0][process.argv[4]]) : "copies:" + one.length)
' "$ZONE_FAKE_STORE" "$1" "$2" "$3"; }
copies(){ grep -c "\"key\": \"$1\"" "$ZONE_FAKE_STORE"; }
store_sum(){ shasum "$ZONE_FAKE_STORE" | cut -d' ' -f1; }

echo "=== the first read fills the cache ==="
zone read --fresh >/dev/null
got="$(seen DATABASE_URL)"
[ "$got" = '"PROD"' ] && ok "production reads PROD" || no "production read $got"

echo
echo "=== an unknown flag is refused, naming it, before anything runs ==="
for cmd in "save --name database-url --zone moon --commit" "read --name database-url --zone moon" "toss --name database-url --zone moon" "load --zone moon -- true" "hook --name database-url --zone moon"; do
  before=$(calls); sum=$(store_sum)
  # shellcheck disable=SC2086
  out="$(printf 'MOON\n' | zone $cmd)"; code=$?
  verb="${cmd%% *}"
  echo "$out" | grep -qi 'unknown flag "--zone"' && ok "$verb: refuses --zone by name" || no "$verb: did not refuse --zone: $out"
  echo "$out" | grep -q '\-\-spot' && ok "$verb: lists the real flags" || no "$verb: does not list --spot: $out"
  [ "$(calls)" = "$before" ] && ok "$verb: the provider was not called" || no "$verb: the provider was called"
  [ "$(store_sum)" = "$sum" ] && ok "$verb: nothing changed at the provider" || no "$verb: the store changed"
done

echo
echo "=== a name declared in two zones is refused without --spot ==="
before=$(calls); sum=$(store_sum)
out="$(printf 'MOON\n' | zone save --name database-url --commit)"; echo "$out"
echo "$out" | grep -q 'database-url is declared at base and base/moon' && ok "names both zones" || no "does not name the zones: $out"
echo "$out" | grep -q 'zone save --name database-url --spot base$' && ok "shows the command for the root" || no "no root command: $out"
echo "$out" | grep -q 'zone save --name database-url --spot base/moon$' && ok "shows the command for moon" || no "no moon command: $out"
[ "$(store_sum)" = "$sum" ] && ok "nothing was written" || no "the store changed"
grep -qE 'secret (create|update)' "$ZONE_FAKE_LOG" && no "a write reached the provider" || ok "no write reached the provider"
out="$(printf 'MOON\n' | zone save --name database-url)"
echo "$out" | grep -q 'declared at base and base/moon' && ok "the report-only form refuses too" || no "report-only did not refuse: $out"

echo
echo "=== a name declared once needs no --spot ==="
out="$(zone save --name api-key)"; echo "$out"
echo "$out" | grep -q 'would write api-key at base' && ok "api-key goes to base" || no "api-key: $out"

echo
echo "=== the report names where the value goes and who reads it ==="
out="$(zone save --name database-url --spot moon)"; echo "$out"
echo "$out" | grep -q 'would write database-url at base/moon' && ok "names the target zone" || no "no target: $out"
echo "$out" | grep -q 'read by base/moon$' && ok "names the zones that read it" || no "no reach: $out"
echo "$out" | grep -q 'not touched: base, which keep their own values' && ok "names the zone it leaves alone" || no "no others: $out"
out="$(zone save --name database-url --spot base)"; echo "$out"
echo "$out" | grep -q 'read by base, base/site and base/site/home$' && ok "a root save reaches every zone below except the override" || no "root reach: $out"
echo "$out" | grep -q 'not touched: base/moon' && ok "and leaves moon alone" || no "root others: $out"

echo
echo "=== --spot naming a zone that does not declare the name is refused ==="
sum=$(store_sum)
out="$(printf 'X\n' | zone save --name database-url --spot site --commit)"; echo "$out"
echo "$out" | grep -q 'database-url is not declared at base/site' && ok "refused, naming the zone" || no "not refused: $out"
echo "$out" | grep -q '\-\-spot base/moon' && ok "and lists the zones that do" || no "no list: $out"
[ "$(store_sum)" = "$sum" ] && ok "nothing was written" || no "the store changed"

echo
echo "=== a moon save creates moon's own copy and leaves production's ==="
prod_note="$(field database-url base note)"
out="$(printf 'MOON\n' | zone save --name database-url --spot moon --commit)"; echo "$out"
echo "$out" | grep -q 'database-url made at base/moon' && ok "made at base/moon" || no "not made at moon: $out"
echo "$out" | grep -q 'left alone: 1 other' && ok "says it left the other zone's copy" || no "no left-alone line: $out"
[ "$(copies database-url)" = "2" ] && ok "two copies under the key" || no "$(copies database-url) copies"
[ "$(field database-url base value)" = "PROD" ] && ok "production's value is unchanged" || no "production now holds $(field database-url base value)"
[ "$(field database-url base note)" = "$prod_note" ] && ok "production's note is unchanged" || no "production's note became $(field database-url base note)"
[ "$(field database-url base/moon note)" = "list zone, <base/moon>" ] && ok "moon's copy names moon alone" || no "moon's note is $(field database-url base/moon note)"
got="$(seen DATABASE_URL base)"
[ "$got" = '"PROD"' ] && ok "load base reads PROD" || no "load base read $got"
got="$(seen DATABASE_URL moon)"
[ "$got" = '"MOON"' ] && ok "load moon reads MOON" || no "load moon read $got"
got="$(seen DATABASE_URL site/home)"
[ "$got" = '"PROD"' ] && ok "load site/home inherits PROD" || no "load site/home read $got"
out="$(zone scan)"
echo "$out" | grep -q 'every zone is whole' && ok "zone scan: every zone is whole" || no "scan: $out"

echo
echo "=== a second moon save updates moon's copy alone ==="
out="$(printf 'MOON-2\n' | zone save --name database-url --spot base/moon --commit)"; echo "$out"
echo "$out" | grep -q 'database-url grew at base/moon' && ok "grew at base/moon" || no "$out"
[ "$(copies database-url)" = "2" ] && ok "still two copies" || no "$(copies database-url) copies"
[ "$(field database-url base value)" = "PROD" ] && ok "production still PROD" || no "production now $(field database-url base value)"
[ "$(field database-url base/moon value)" = "MOON-2" ] && ok "moon holds MOON-2" || no "moon holds $(field database-url base/moon value)"

echo
echo "=== a root save leaves the moon override untouched ==="
out="$(printf 'PROD-2\n' | zone save --name database-url --spot base --commit)"; echo "$out"
echo "$out" | grep -q 'database-url grew at base' && ok "grew at base" || no "$out"
[ "$(field database-url base value)" = "PROD-2" ] && ok "production holds PROD-2" || no "production holds $(field database-url base value)"
[ "$(field database-url base/moon value)" = "MOON-2" ] && ok "moon still MOON-2" || no "moon now $(field database-url base/moon value)"
[ "$(field database-url base/moon note)" = "list zone, <base/moon>" ] && ok "moon's note unchanged" || no "moon's note became $(field database-url base/moon note)"
got="$(seen DATABASE_URL moon)"
[ "$got" = '"MOON-2"' ] && ok "load moon reads MOON-2" || no "load moon read $got"
got="$(seen DATABASE_URL base)"
[ "$got" = '"PROD-2"' ] && ok "load base reads PROD-2" || no "load base read $got"

echo
echo "=== read --name is scoped the same way ==="
out="$(zone read --name database-url)"
echo "$out" | grep -q 'Pass --spot to choose' && ok "read --name refuses a shared name" || no "read: $out"
out="$(zone read --name database-url --spot moon)"; echo "$out"
echo "$out" | grep -q 'database-url  declared at base/moon, and present at the provider' && ok "read --spot moon finds moon's copy" || no "read moon: $out"

echo
echo "=== toss is scoped, and removes one zone's copy only ==="
sum=$(store_sum)
out="$(zone toss --name database-url)"
echo "$out" | grep -q 'Pass --spot to choose' && ok "toss refuses a shared name" || no "toss: $out"
[ "$(store_sum)" = "$sum" ] && ok "nothing was removed" || no "the store changed"
out="$(zone toss --name database-url --spot moon)"; echo "$out"
echo "$out" | grep -q 'Removed database-url from base/moon (1 copy' && ok "removed moon's copy" || no "toss moon: $out"
[ "$(copies database-url)" = "1" ] && ok "one copy left" || no "$(copies database-url) copies left"
[ "$(field database-url base value)" = "PROD-2" ] && ok "production's copy survived" || no "production: $(field database-url base value)"

echo
echo "=== no value is ever printed ==="
all="$(cat "$ZONE_FAKE_LOG")"
for v in PROD-2 MOON-2; do
  echo "$all" | grep -q "$v" && no "the provider log holds $v" || ok "never logged $v"
done

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
