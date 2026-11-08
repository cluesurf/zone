# The fake `bws` for the shell suites. Sourced, never run:
#
#   . "$HERE/fake.sh"
#   zone_fake "$ZONE" "$WORK" || exit 1
#
# Zone runs only a `bws` whose sha256 equals the pin for this platform
# (decision 004), and `ZONE_BWS` picks a location, never a different binary.
# So a suite runs a COPY of the package whose one pin, this platform's binary
# hash, is the fake's (test/fake-bws.mjs), and points ZONE_BWS at the fake.
# Nothing that ships has a switch for this, and the package's own source is
# never rewritten.
#
# The copy also leaves out `link/`, `host/`, `node_modules` and `tmp`, so a
# suite boots what a fresh clone holds.
#
# Sets and exports:
#
#   ZONE_SRC          the copy. Boot `$ZONE_SRC/code/line/base.tree`
#   ZONE_BWS          the fake, at $WORK/bws/bws
#   ZONE_FAKE_STORE   its secrets, $WORK/bws/store.json. Absent, the fake
#                     serves its fixture, and the first write creates it
#   ZONE_FAKE_LOG     one line per call and never a value, $WORK/bws/calls.log
#
# The fake keeps its state beside itself, never in a variable, because zone
# hands `bws` a short environment and nothing a test exports reaches it.

zone_fake(){
  local zone="$1" work="$2"

  mkdir -p "$work/bws" "$work/zone" || return 1
  cp "$zone/test/fixture/bin/bws" "$work/bws/bws" || return 1
  chmod 755 "$work/bws/bws" || return 1
  rsync -a \
    --exclude=.git --exclude=node_modules --exclude=.base --exclude=host \
    --exclude=link --exclude=tmp --exclude=build --exclude=.term --exclude=test \
    "$zone/" "$work/zone/" || return 1
  node "$zone/test/fake-bws.mjs" "$work/zone/code/hold/runtime/vault.ts" "$work/bws/bws" || return 1

  ZONE_SRC="$work/zone"
  ZONE_BWS="$work/bws/bws"
  ZONE_FAKE_STORE="$work/bws/store.json"
  ZONE_FAKE_LOG="$work/bws/calls.log"
  : > "$ZONE_FAKE_LOG"
  export ZONE_SRC ZONE_BWS ZONE_FAKE_STORE ZONE_FAKE_LOG
}
