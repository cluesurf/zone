#!/usr/bin/env bash
# The console's help surface.
#
#   bash test/help.sh
#
# Three things, none of which stay true on their own:
#
#   the top-level help fits one terminal screen
#   no line runs past 80 columns
#   every command it lists is real, and every real command is listed
#
# The last one is the one that rots. A command gets added to the dispatcher
# and not to the help, or renamed in one place, and the help quietly starts
# lying. Comparing the two lists in both directions is the only way that
# stays honest.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ZONE="$(cd "$HERE/.." && pwd)"
. "$HERE/term.sh"
zone_term_find "$ZONE" || exit 1

# One screen. 24 rows is the traditional terminal, and the prompt that ran
# the command takes one, so the help gets the rest.
ROWS=23
COLS=80

PASS=0; FAIL=0
ok(){ printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
zone(){ ( cd "$ZONE" && node "$TERM_HOST" boot code/line/base.tree -- "$@" 2>&1 \
  | grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script' ); }

printf '\n=== help fits one screen ===\n'
# from the `zone [command]` line on, term's help layout (zone decision 002): `term boot` reports its own build as
# items above it (output standard, 2026-10-04), which the filter in `zone` above predates, and those lines are not the
# help
HELP="$(zone --help | sed -n '/^zone \[command\]/,$p')"
[ -n "$HELP" ] && ok "the help is term's layout, under the program's name" || no "no 'zone [command]' line in the help"
lines=$(printf '%s\n' "$HELP" | wc -l | tr -d ' ')
[ "$lines" -le "$ROWS" ] && ok "$lines lines, at most $ROWS" || no "$lines lines, over $ROWS"

widest=$(printf '%s\n' "$HELP" | awk '{ if (length($0) > m) m = length($0) } END { print m+0 }')
[ "$widest" -le "$COLS" ] && ok "widest line $widest, at most $COLS" || no "widest line $widest, over $COLS"

printf '\n=== the version, as term answers its own ===\n'
# zone decision 002, zone-0146: -v and --version answer the manifest's mark, the opening line of a run names
# `zone <mark>`, and the printer's tool line in tool/say.tree is that same mark
MARK=$(awk '/^  mark </ { sub(/^  mark </, ""); sub(/>.*/, ""); print; exit }' "$ZONE/deck.tree")
[ -n "$MARK" ] && ok "deck.tree marks $MARK" || no "no mark in deck.tree"
for flag in -v --version; do
  said="$(zone "$flag" | tail -1)"
  [ "$said" = "$MARK" ] && ok "zone $flag answers $MARK" || no "zone $flag answered '$said', not $MARK"
done
grep -q "host zone-tool, text <zone $MARK>" "$ZONE/code/tool/say.tree" \
  && ok "the opening's tool is zone $MARK" || no "code/tool/say.tree zone-tool is not zone $MARK"
# `zone deck` reads only declarations on disk: no binding, no keystore, no provider
said="$(zone deck)"
printf '%s\n' "$said" | grep -qx "  zone $MARK" && ok "a run opens with zone $MARK" || no "no 'zone $MARK' line under the opening: $said"

printf '\n=== an unknown command or flag, in term'"'"'s error shape ===\n'
# exit 2, the failed item, the closing `The command line was not understood`, and a next hint
bad(){ ( cd "$ZONE" && node "$TERM_HOST" boot code/line/base.tree -- "$@" > "$WORK_HELP/out" 2>&1 ); echo $?; }
WORK_HELP="$(mktemp -d)"
code=$(bad lsit)
out="$(cat "$WORK_HELP/out")"
[ "$code" = "2" ] && ok "a mistyped command exits 2" || no "a mistyped command exited $code"
printf '%s' "$out" | grep -q 'There is no command named lsit' && ok "it names the word" || no "no 'There is no command named lsit': $out"
printf '%s' "$out" | grep -q 'The command line was not understood' && ok "it closes in term's words" || no "no closing: $out"
printf '%s' "$out" | grep -q 'next zone list' && ok "it names the nearest command" || no "no 'next zone list': $out"
code=$(bad show --nope)
out="$(cat "$WORK_HELP/out")"
[ "$code" = "2" ] && ok "an unknown flag exits 2" || no "an unknown flag exited $code"
printf '%s' "$out" | grep -q 'Unknown flag "--nope"' && ok "it names the flag" || no "no 'Unknown flag \"--nope\"': $out"
printf '%s' "$out" | grep -q 'next zone --help' && ok "it points at the help" || no "no 'next zone --help': $out"

printf '\n=== every listed command is real ===\n'
# term's layout names each command under the program: `  zone bind   Configure ...`
listed=$(printf '%s\n' "$HELP" | awk '/^  zone [a-z]/ { print $2 }' | sort)
for c in $listed; do
  out="$(zone "$c" --help 2>&1)"
  printf '%s' "$out" | grep -qiE 'unknown|not a command' \
    && no "help lists $c, which the console does not know" \
    || ok "$c is real"
done

printf '\n=== every real command is listed ===\n'
# The dispatcher is the source of truth: a top-level `hook <name>` in the
# console is one command. Indented hooks are a command's own subcommands and
# do not belong in the top-level list. Since cli-in-term-0011 the console is
# ONE program hook (`hook zone`, decision term/003 part 3) whose nested hooks
# are the commands, so a lone top-level hook means its children, the hooks at
# two spaces.
real=$(awk '/^hook [a-z]/ { print $2 }' "$ZONE/code/line/base.tree" | sort -u)
if [ "$(printf '%s\n' "$real" | grep -c .)" -eq 1 ]; then
  real=$(awk '/^  hook [a-z]/ { print $2 }' "$ZONE/code/line/base.tree" | sort -u)
fi
missing=""
for c in $real; do
  printf '%s\n' "$listed" | grep -qx "$c" || missing="$missing $c"
done
count=$(printf '%s\n' "$real" | wc -l | tr -d ' ')
# A drift check that finds no commands would pass while checking nothing.
[ "$count" -ge 10 ] || no "only found $count commands in the dispatcher, so this check is not looking at the right thing"
[ -z "$missing" ] && ok "the help lists all $count commands" \
  || no "not listed in the help:$missing"

printf '\n=== every task the console binds is actually exported ===\n'
# THE CHECK ABOVE CANNOT SEE THIS, and a broken command proved it.
#
# A `task <name>` line in the console names the implementation the
# dispatcher looks up at RUN TIME. Names in Term are package-global, so a
# task whose name collides with one already in the closure is renamed by
# the compiler to dodge the clash: `trim` collided with the stdlib's
# `trim` and came out as `trim11`. The build is clean, the help is
# correct, and `zone trim` dies with `task "trim" is not exported by
# the program`.
#
# Nothing else here catches that. `<command> --help` prints usage
# WITHOUT resolving the task, and the "is real" test only fails on the
# words `unknown` or `not a command`, which that error does not contain.
# So every check passed on a command that could not run at all.
#
# Static, against the built output, because the alternative is running
# each command for real and most of them write something.
for t in $(awk '/^[[:space:]]*task [a-z]/ { print $2 }' "$ZONE/code/line/base.tree" | sort -u); do
  camel=$(printf '%s' "$t" | awk -F- '{ printf "%s", $1; for (i = 2; i <= NF; i++) printf "%s%s", toupper(substr($i, 1, 1)), substr($i, 2) }')

  # The open paren matters: it is what tells `wash` from `wash11`.
  #
  # Since 2026-10-05 `term make` compiles each module on its own, and the
  # console's artifact re-exports each task from the module that defines
  # it: `export { bank } from '...'`, or `export { bank__in0_1 as bank }`
  # where a name was split apart. The exported name must be the task's
  # own, which is what the second pattern asks, so `wash11` still fails.
  if grep -rqE "^export (async )?function ${camel}\(" "$ZONE/host/code" ||
    grep -qE "^export \{ (.*, )?([A-Za-z0-9_]+ as )?${camel}(,| \})" "$ZONE/host/code/line/base.ts"; then
    ok "$t is exported"
  else
    no "$t is NOT exported. The compiler probably renamed it to dodge a name already in the closure, so the dispatcher will not find it"
  fi
done

printf '\n=== every command says the same thing when there is no declaration ===\n'
# Six commands reach this check and used to say four different things: some
# named the directory and offered `zone lift`, some named it and offered
# nothing, some said "at or above this directory" without saying which.
EMPTY="$(mktemp -d)"
say_no_deck(){ ( cd "$EMPTY" && node "$TERM_HOST" boot "$ZONE/code/line/base.tree" -- "$@" 2>&1 \
  | grep -vE '→ Booting|✓ Built|✓ Cached|Compiling|No build script' ); }

for spec in "list" "read" "deck" "save" "load base -- true" "move wrangler --place x"; do
  name="${spec%% *}"
  # shellcheck disable=SC2086
  out="$(say_no_deck $spec)"
  ok_path=0; ok_fix=0
  printf '%s' "$out" | grep -q "$EMPTY"    && ok_path=1
  printf '%s' "$out" | grep -q 'zone lift' && ok_fix=1
  if [ "$ok_path" = 1 ] && [ "$ok_fix" = 1 ]; then
    ok "$name names where it looked, and what to run"
  else
    no "$name: path=$ok_path fix=$ok_fix"
  fi
done
rmdir "$EMPTY" 2>/dev/null

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
