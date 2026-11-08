// What the TypeScript tests need from outside the package, and where it
// comes from, so it comes from nowhere else.
//
//   stripTypes   a runtime shim's TypeScript, as JavaScript. Node's own type
//                stripping (node 22.13 and later), so no esbuild and no
//                borrowed node_modules. The shims are plain declarations
//                with no import, export or enum, which is what stripping
//                handles.
//   termBase     the standard library of the Term release this package
//                builds with, where the runtime natives `term boot` prepends
//                live. Set by test/term.sh as ZONE_TERM_BASE, from the
//                installed `term` resolving deck.tree's `need @term/code`.
import { stripTypeScriptTypes } from 'node:module'

export const stripTypes = (source: string): string => {
  // The experimental warning is printed once per process and says nothing
  // a test reader needs.
  const emit = process.emitWarning
  process.emitWarning = () => {}
  try {
    return stripTypeScriptTypes(source)
  } finally {
    process.emitWarning = emit
  }
}

export const termBase = (): string => {
  const base = process.env.ZONE_TERM_BASE
  if (!base) {
    throw new Error(
      'ZONE_TERM_BASE is not set. Run through test/all.sh, or source test/term.sh and call zone_term_find first',
    )
  }
  return base
}
