// Prove a packed `@term/zone` (the folder a Term registry publish sends, or
// one `term save @term/zone -g` placed) holds no secret, printing NO value.
//
//   node task/scan-pack.cjs <extracted package dir>
//   zone load mesh -- node /abs/path/to/zone/task/scan-pack.cjs <dir>   also compares every mesh value
//
// Reports, per file, counts only:
//
//   forbidden paths    .env*, .npmrc, a zone cache, tmp/, test/, .base/
//   secret shapes      postgres urls with a password, BWS tokens (`0.` uuid
//                      shapes), `sk_`/`rk_` keys, PEM blocks, BWS_ACCESS_TOKEN
//                      assignments
//   long runs          base64 runs of 40+ and hex runs of 32+ characters,
//                      reported with their line number and length so a
//                      person can look, never their text
//   environment        every value in this process's environment of 12+
//                      characters, looked for as a substring. Under
//                      `zone load` that is every secret the zone holds
//
// Exit 1 when anything but a long run is found. Long runs are listed for a
// look, because minified code carries legitimate ones.
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
if (!root || !fs.existsSync(root)) {
  console.error('usage: scan-pack.cjs <extracted package dir>')
  process.exit(2)
}

const files = []
const walk = dir => {
  for (const one of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, one.name)
    if (one.isDirectory()) walk(at)
    else files.push(at)
  }
}
walk(root)

const FORBIDDEN = [/(^|\/)\.env/, /(^|\/)\.npmrc$/, /zone\.code\.tree$/, /(^|\/)tmp\//, /(^|\/)test\//, /(^|\/)\.base\//]

const SHAPES = {
  'postgres url with password': /postgres(ql)?:\/\/[^\s:@/"'`]+:[^\s@"'`]+@/g,
  'bws access token': /\b0\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9+/=]{10,}/g,
  'stripe-style key': /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/g,
  'pem block': /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  'BWS_ACCESS_TOKEN assignment': /BWS_ACCESS_TOKEN\s*[=:]\s*["'][^"'$]{8,}/g,
}

const LONG = { base64: /[A-Za-z0-9+/]{40,}={0,2}/g, hex: /\b[0-9a-f]{32,}\b/gi }

const env = Object.entries(process.env)
  .filter(([, v]) => typeof v === 'string' && v.length >= 12)
  // Paths and the PATH itself are not secrets, and they match by design.
  .filter(([k, v]) => !/^(PATH|HOME|PWD|OLDPWD|SHELL|TMPDIR|NODE_PATH|MANPATH|INFOPATH|_)$/.test(k) && !v.startsWith('/'))

let bad = 0
let looked = 0

for (const file of files) {
  const rel = path.relative(root, file)
  const text = fs.readFileSync(file, 'utf8')
  const found = []

  if (FORBIDDEN.some(re => re.test(rel))) found.push('forbidden path')

  for (const [name, re] of Object.entries(SHAPES)) {
    const n = (text.match(re) ?? []).length
    if (n) found.push(`${n} ${name}`)
  }

  // The NAME of a matching variable is printed, never its value: a name
  // says what to look at, and names are in the declaration anyway.
  const envHits = env.filter(([, v]) => text.includes(v)).map(([k]) => k)
  if (envHits.length) found.push(`environment value of ${envHits.join(', ')}`)

  if (found.length) {
    bad += found.length
    console.log(`  BAD   ${rel}: ${found.join(', ')}`)
  }

  const lines = text.split('\n')
  for (const [kind, re] of Object.entries(LONG)) {
    lines.forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        looked += 1
        console.log(`  look  ${rel}:${i + 1} ${kind} run of ${m[0].length}`)
      }
    })
  }
}

console.log(
  `\n  ${files.length} files, ${env.length} environment values compared, ` +
    `${bad} finding(s), ${looked} long run(s) to look at`,
)
process.exit(bad ? 1 : 0)
