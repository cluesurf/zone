// The fake `bws`, made reachable for one test run, with nothing that ships.
//
//   node test/fake-bws.mjs <vault.ts of a COPY> <fake bws>
//
// Zone runs only a `bws` whose sha256 equals the pin for this platform, and
// `ZONE_BWS` picks a location, never a different binary. So the fake is
// reached the way the finding allows (decision 004, finding section 2): by
// handing the code the fake's hash directly. This rewrites ONE pin, this
// platform's binary hash, in a COPY of `vault.ts` that a test builds or
// evaluates. The package's own file is never touched, and the script refuses
// to rewrite a file inside the package's `code/` folder.
//
// Imported by the TypeScript tests for `pinFake`, run by `test/fake.sh` for
// the shell suites.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const shaOf = path =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

// The source with this platform's binary pin replaced by `hash`, or a thrown
// refusal when the row is not found exactly once.
export const pinFake = (source, hash, key = `${process.platform}-${process.arch}`) => {
  const row = source.indexOf(`'${key}': {`)

  if (row < 0 || source.indexOf(`'${key}': {`, row + 1) >= 0) {
    throw new Error(`no single pin row for ${key}`)
  }

  const rest = source.slice(row)
  const found = rest.match(/bin: '[0-9a-f]{64}'/)

  if (!found || found.index === undefined) {
    throw new Error(`the ${key} row has no binary hash`)
  }

  const at = row + found.index

  return source.slice(0, at) + `bin: '${hash}'` + source.slice(at + found[0].length)
}

const main = () => {
  const [target, fake] = process.argv.slice(2)

  if (!target || !fake) {
    process.stderr.write('usage: node test/fake-bws.mjs <vault.ts of a copy> <fake bws>\n')
    process.exit(2)
  }

  const own = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'code'))
  const where = relative(own, realpathSync(target))

  if (!where.startsWith('..') && !isAbsolute(where)) {
    process.stderr.write('fake-bws: refusing to rewrite the package\'s own vault.ts. Copy it first.\n')
    process.exit(1)
  }

  writeFileSync(target, pinFake(readFileSync(target, 'utf8'), shaOf(fake)))
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
