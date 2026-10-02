// Write one master key, tone-packed, to the file named on the command line.
//
//   pnpm exec tsx test/make-key.ts /somewhere/key
//
// TO A FILE, NOT TO STDOUT. `pnpm exec` writes its own lines to stdout
// ("Already up to date", "Done in 141ms"), so a `| tail -1` around it can
// pick up a pnpm status line instead of the key. That yields a string that
// unpacks to the wrong number of bytes, and it surfaces as a stack trace out
// of SubtleCrypto.importKey with nothing pointing back here.
import './shim'
import { writeFileSync } from 'node:fs'

// `tonePack` from the seal module's own build, which carries the stdlib's tone code inlined. It was read from
// `host/link/@term/seed/code/tone`, a file the build had stopped writing on 2026-08-30, so the test kept passing on
// a stale copy until the stdlib rename on 2026-10-02 pointed it at a path nothing had ever written.
const { makeKey, tonePack } = await import('../host/code/seal/base')

const out = process.argv[2]

if (!out) {
  process.stderr.write('make-key: needs a path to write the key to\n')
  process.exit(1)
}

writeFileSync(out, tonePack(await makeKey()), { mode: 0o600 })
