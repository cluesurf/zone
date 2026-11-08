#!/usr/bin/env bash
# Every zone suite, in one command.
#
#   bash test/all.sh                 from this package
#   bash test/all.sh --only note     one suite, while iterating
#   bash test/all.sh --list          name the suites and stop
#
# `--only` takes a substring and matches suite names. It exists because
# the alternative is
# what everybody actually does instead: a throwaway shell script that
# cd's into the package and runs one file, written again every time.
#
# Ordered cheapest first, so a broken build fails in seconds rather than
# after two minutes of shell harnesses.
#
#   alone    nothing in the package reaches outside it: no path from this
#            machine, no relative path climbing out, no link into a Term
#            checkout, in source, tests, docs or the npm payload
#   tree     the language-level tests, run by the Term test runner
#   note     the secret note: written as `host` data, read by the compiler
#   seal     sealing and opening, including refusal on a tampered value
#   cache    the on-disk cache shape and its warm-read budget
#   vault    every provider call through the runner, against the fake bws:
#            exact arguments, every value shape, redaction, the short env
#   bin      the pinned bws fetch: a local server, a fake binary, every
#            refusal leaving nothing behind
#   help     the console's help surface, and drift between it and the dispatcher
#   fresh    cache freshness, and that a good cache never calls the provider
#   save     `zone save --name`: every value shape byte for byte, the cache
#            following the write, a bind edit reaching the next load
#   spot     a name two zones keep apart: unknown flags refused, a shared
#            name refused without --spot, each zone's value its own
#   built    the same, through call/zone.mjs and a host/line console built
#            from the test copy: zone with node alone, no Term CLI
#   load     `zone load` end to end against a local cache
#   e2e      the whole pipeline against a fake provider, no keychain, no network
#
# Nothing here touches a real credential, a system keychain, or the network.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"

cd "$ZONE" || exit 1

ONLY=""
LIST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) shift ;;
  esac
done

NAMES="alone tree/base tree/read tree/zone tree/note tree/stamp note seal cache vault bin help fresh save spot built load e2e"

if [ -n "$LIST" ]; then
  for n in $NAMES; do echo "$n"; done
  exit 0
fi

# FIRST, and before the build: a package that reaches outside itself builds
# here and nowhere else, so every later suite would pass for the wrong reason.
ALONE=0
ALONE_NAME=alone
if [ -z "$ONLY" ] || [ "${ALONE_NAME#*$ONLY}" != "$ALONE_NAME" ]; then
  ALONE=1
  printf '\n\033[1m── alone\033[0m\n'
  if node test/alone.mjs; then
    printf '   \033[32mpassed\033[0m\n'
  else
    printf '\n\033[31mfailed: alone\033[0m\n'
    exit 1
  fi
  if [ "$ONLY" = "alone" ]; then
    printf '\n\033[32m1 zone suite(s) passed\033[0m\n'
    exit 0
  fi
fi

# The Term release deck.tree asks for, found through the installed `term`.
. "$HERE/term.sh"
zone_term_find "$ZONE" || exit 1
echo "term $TERM_HOST"

FAILED=""
RAN=$ALONE
run(){
  local name="$1"; shift

  # `--only` is a SUBSTRING, so `--only tree` runs all three tree suites
  # and `--only note` runs the one.
  if [ -n "$ONLY" ] && [ "${name#*$ONLY}" = "$name" ]; then
    return 0
  fi

  RAN=$((RAN + 1))
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '   \033[32mpassed\033[0m\n'
  else
    printf '   \033[31mFAILED\033[0m\n'
    FAILED="$FAILED $name"
  fi
}

printf '\033[1mbuilding\033[0m\n'
node "$TERM_HOST" make >/dev/null 2>&1 || { echo "  the build failed. Run \`term make\` to see why."; exit 1; }
echo "  built"

for t in base read zone note stamp; do
  run "tree/$t" node "$TERM_HOST" test "test/$t.tree"
done
run note  pnpm exec tsx test/note.ts
run seal  pnpm exec tsx test/seal.ts
run cache pnpm exec tsx test/cache.ts
run vault pnpm exec tsx test/vault.ts
run bin   pnpm exec tsx test/bin.ts
run help  bash test/help.sh
run fresh bash test/fresh.sh
run save  bash test/save.sh
run spot  bash test/spot.sh
run built env ZONE_BUILT=1 bash test/spot.sh
run load  bash test/load.sh
run e2e   bash test/e2e.sh

if [ -n "$FAILED" ]; then
  printf '\n\033[31mfailed:%s\033[0m\n' "$FAILED"
  exit 1
fi

# A FILTER THAT MATCHES NOTHING MUST NOT READ AS SUCCESS. `--only nope`
# running zero suites and printing "passed" is the shape of gate that
# gets believed while checking nothing.
if [ "$RAN" -eq 0 ]; then
  printf '\n\033[31mno suite matched --only %s\033[0m\n' "$ONLY"
  printf 'Run `bash test/all.sh --list` to see the names.\n'
  exit 1
fi

if [ -n "$ONLY" ]; then
  printf '\n\033[32m%s zone suite(s) passed\033[0m\n' "$RAN"
else
  printf '\n\033[32mevery zone suite passed\033[0m\n'
fi
