// Zone stands alone: nothing in it reaches outside its own folder.
//
//   node test/alone.mjs            from this package, or `bash test/all.sh`
//
// A package that reads a path from the machine it was written on, or climbs
// out of its own folder into a neighbour, builds there and nowhere else. It
// passes every test on that one machine and fails on a fresh clone, in a
// container, and for anyone who installs it. So this runs first, before the
// build, and refuses:
//
//   a home path       /Users/<name>, /home/<name>, C:\Users\<name>, or ~/base
//   a checkout path   the names of the two folders this package sits in, or
//                     this machine's user name, read when it runs
//   a climb out       any ../ path that, resolved from the file it is in,
//                     lands outside this package. `$ZONE/..` and `cwd()}/..`
//                     count, since both start at the package
//   a link out        anything under link/ or node_modules/ that resolves
//                     outside this package (a `term link` into a checkout)
//
// Scanned: every file but build output, installs, caches and scratch, plus
// the npm payload (package.json `files`), because the payload is generated
// and is what everyone else runs.
//
// Prints each finding as file:line and the kind. Exit 1 on any.
import { readdirSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'

const ZONE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Build output, installs, caches and scratch: not the package's own text.
// `host` is generated, but its npm payload is scanned on its own below.
const SKIP = new Set(['.git', 'node_modules', '.base', 'host', 'link', 'tmp', 'build', '.term'])

// Bytes, not text: a binary is not scanned.
const BINARY = /\.(node|png|jpg|jpeg|gif|ico|woff2?|ttf|otf|zip|gz|zst|tar|wasm)$/i

// this machine's own names, read when the check runs, so the check names no machine itself
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const above = ZONE.split(sep).filter(Boolean).slice(-3, -1)
const user = (() => {
  try {
    return userInfo().username
  } catch {
    return ''
  }
})()
const HOME_PATH = [
  [/\/Users\/[A-Za-z0-9._-]+/g, 'a home path'],
  [/\/home\/[A-Za-z0-9._-]+\//g, 'a home path'],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, 'a home path'],
  [/~\/base\b/g, 'a home path'],
  ...(above.length === 2 ? [[new RegExp(`\\b${escape(above.join('/'))}\\b`, 'g'), 'a checkout path']] : []),
  ...(user.length > 2 ? [[new RegExp(`\\b${escape(user)}\\b`, 'g'), 'a home path']] : []),
]

// A climb that starts at the package itself, whatever file it is written in.
const FROM_TOP = [
  [/\$\{?ZONE\}?\/\.\.(\/|"|'|$)/g, 'a climb out of the package'],
  [/cwd\(\)\}?\/\.\.\//g, 'a climb out of the package'],
]

// A relative path: one or more ../ followed by a name.
const CLIMB = /(?:^|[^\w.$}/])((?:\.\.\/)+)[\w@-]/g

const findings = []
const note = (file, line, kind, text) =>
  findings.push(`  ${relative(ZONE, file)}:${line}  ${kind}: ${text.trim().slice(0, 120)}`)

const scan = (file, { climb = true } = {}) => {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  // The check's own patterns name what they refuse.
  if (file === fileURLToPath(import.meta.url)) return

  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const [re, kind] of [...HOME_PATH, ...FROM_TOP]) {
      re.lastIndex = 0
      if (re.test(line)) note(file, i + 1, kind, line)
    }
    if (!climb) return
    CLIMB.lastIndex = 0
    for (const m of line.matchAll(CLIMB)) {
      const target = resolve(dirname(file), m[1])
      if (target !== ZONE && !target.startsWith(ZONE + sep)) {
        note(file, i + 1, 'a climb out of the package', line)
      }
    }
  })
}

const walk = dir => {
  for (const one of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, one.name)
    if (one.isDirectory()) {
      if (dir === ZONE && SKIP.has(one.name)) continue
      if (one.name === 'node_modules') continue
      walk(at)
    } else if (one.isFile() && !BINARY.test(one.name)) {
      scan(at)
    }
  }
}

walk(ZONE)

// The npm payload. Generated, so a path the compiler wrote into it from this
// machine shows here and nowhere in the source. Climbs are not checked:
// a bundle's relative imports are its own.
const pkg = JSON.parse(readFileSync(join(ZONE, 'package.json'), 'utf8'))
for (const entry of pkg.files ?? []) {
  const at = join(ZONE, entry)
  if (!entry.startsWith('host/') || !existsSync(at)) continue
  scan(at, { climb: false })
}

// Links out: a `term link` or an install that points into another checkout.
const linksOut = dir => {
  if (!existsSync(dir)) return
  for (const one of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, one.name)
    const stat = lstatSync(at)
    if (stat.isSymbolicLink()) {
      let real
      try {
        real = realpathSync(at)
      } catch {
        continue
      }
      if (real !== ZONE && !real.startsWith(ZONE + sep) && !real.includes(`${sep}node_modules${sep}`)) {
        findings.push(`  ${relative(ZONE, at)}  a link out of the package, to ${real}`)
      }
    } else if (stat.isDirectory() && one.name.startsWith('@')) {
      linksOut(at)
    }
  }
}
linksOut(join(ZONE, 'link'))

if (findings.length) {
  console.log(`zone reaches outside itself, ${findings.length} place(s):\n`)
  console.log(findings.join('\n'))
  console.log(
    '\nA fresh clone has none of these. Use a path inside the package, the' +
      ' installed `term` (test/term.sh), or an environment variable.' +
      ' A link out is local state: remove it with `rm -r link`.',
  )
  process.exit(1)
}

console.log('  nothing reaches outside the package')
