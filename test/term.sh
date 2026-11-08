# The Term toolchain these tests build and boot with. Sourced, never run:
#
#   . "$HERE/term.sh"
#
# Zone is compiled by Term, and the version is the one `deck.tree` asks for
# (`need @term/code, mark <2.10.x>`), resolved by the `term` installed on this
# machine. Nothing here reaches a Term checkout by path: a fresh clone of
# zone and an installed `term` are the whole of what it needs.
#
# Sets, and exports so a harness started by `all.sh` does not resolve again:
#
#   TERM_HOST        the resolved release's `host/line.js`. Run with node, it
#                    IS that release, with no version dispatch, which is what
#                    a harness that sets HOME to a sandbox needs: the front's
#                    dispatch looks for installed versions under HOME
#   ZONE_TERM_BASE   that release's standard library, where the TypeScript
#                    tests read the runtime natives `term boot` prepends
#
# Overrides, in order: ZONE_TERM_HOST and ZONE_TERM_BASE name both outright.
# ZONE_TERM names the `term` command to resolve with. Otherwise the first
# `term` on PATH that is not under a node_modules folder: the npm package of
# an older Term there predates `need` and would answer its own version.
#
# Must be sourced BEFORE a harness changes HOME.

# A suite's own folder, under /tmp and never macOS's TMPDIR. The copy of zone a suite boots is the build's root, and
# Term 2.10.0's role reader (deck/call/code/role-of.ts packageRootOf) stops climbing toward a dependency's deck.tree
# once the folder it is in is no longer than that root. Under /var/folders/<..>/T/tmp.X/zone (77 characters) it gave
# up below @term/call's own folder, read the printer's lean modules long-form, and every boot failed with 72 errors in
# work/item/standard.tree (zone-0146 trap). A short root reads @term/call's role.tree.
zone_work(){
  mktemp -d /tmp/zone.XXXXXX
}

zone_term_find(){
  local zone="$1" front="" c dir real root v cand

  if [ -n "${ZONE_TERM_HOST:-}" ]; then
    TERM_HOST="$ZONE_TERM_HOST"
  elif [ -n "${TERM_HOST:-}" ] && [ -f "$TERM_HOST" ] && [ -n "${ZONE_TERM_BASE:-}" ]; then
    return 0
  else
    if [ -n "${ZONE_TERM:-}" ]; then
      front="$ZONE_TERM"
    else
      local IFS=:
      for dir in $PATH; do
        case "$dir" in */node_modules/*|*/node_modules) continue ;; esac
        if [ -x "$dir/term" ]; then front="$dir/term"; break; fi
      done
      unset IFS
    fi

    if [ -z "$front" ]; then
      echo "zone: no \`term\` on PATH. Install Term (https://term.surf), or set ZONE_TERM" >&2
      return 1
    fi

    # The version deck.tree asks for, as the installed term resolves it. Asked
    # from inside the package, because resolution reads the nearest deck.tree.
    # Installs the release on first use.
    v="$(cd "$zone" && "$front" --version 2>/dev/null | tail -1)"
    if [ -z "$v" ]; then
      echo "zone: \`$front --version\` answered nothing from $zone" >&2
      return 1
    fi

    real="$(node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$front")"
    root="$(cd "$(dirname "$real")/.." && pwd)"

    # The front is either the home's `bin/term`, with each release under
    # `code/<version>/term`, or a release's own `bin/term`, whose siblings
    # are the other releases.
    TERM_HOST=""
    for cand in "$root/code/$v/term" "$root/../../$v/term" "$root"; do
      if [ -f "$cand/host/line.js" ] && [ -f "$cand/package.json" ] \
        && node -e 'process.exit(require(process.argv[1]).version === process.argv[2] ? 0 : 1)' "$cand/package.json" "$v"; then
        TERM_HOST="$(cd "$cand" && pwd)/host/line.js"
        break
      fi
    done

    if [ -z "$TERM_HOST" ]; then
      echo "zone: term $v resolved, but its release was not found beside $real. Set ZONE_TERM_HOST to its host/line.js" >&2
      return 1
    fi
  fi

  if [ -z "${ZONE_TERM_BASE:-}" ]; then
    ZONE_TERM_BASE="$(cd "$(dirname "$TERM_HOST")/.." && pwd)/deck/base"
  fi

  export TERM_HOST ZONE_TERM_BASE
}
