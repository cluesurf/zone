// The pinned `bws` fetch, against a local server and a fake binary.
//
//   pnpm exec tsx test/bin.ts
//
// No network beyond 127.0.0.1, no Bitwarden, no secret. `vault.bws.fetch`
// takes the URL, both hashes and the folder as arguments, so the fake `bws`
// below is reached with hashes of its own and the pins are never bypassed by
// anything that ships.
//
// After every refusal the folder must hold exactly what it held before: no
// temp zip, no half-written binary.
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import { stripTypes } from './strip'

const need = createRequire(import.meta.url)
const js = stripTypes(readFileSync('code/hold/runtime/vault.ts', 'utf8'))
const vault = new Function('require', `${js}; return vault`)(need) as {
  bws: {
    version: string
    pins: Record<string, { triple: string; zip: string; bin: string }>
    url: (triple: string) => string
    bin: () => Promise<string>
    fetch: (to: {
      url: string
      zip: string
      bin: string
      folder: string
      name: string
      timeout?: number
    }) => Promise<string>
    fetchNow: (to: {
      url: string
      zip: string
      bin: string
      folder: string
      name: string
      timeout?: number
    }) => string
    unzip: (zip: Uint8Array, name: string) => Uint8Array
  }
}

let pass = 0
let fail = 0
const ok = (w: string) => { console.log(`  ok    ${w}`); pass += 1 }
const no = (w: string) => { console.log(`  FAIL  ${w}`); fail += 1 }
const check = (cond: boolean, w: string) => (cond ? ok(w) : no(w))

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// A zip writer just big enough for the fixtures: local headers, a central
// directory and its end record, stored or deflated entries.
const zipOf = (
  entries: Array<{ name: string; data: Buffer; store?: boolean }>,
): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const one of entries) {
    const name = Buffer.from(one.name, 'utf8')
    const packed = one.store ? one.data : deflateRawSync(one.data)
    const method = one.store ? 0 : 8
    const crc = crc32(one.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(one.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, packed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(one.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + packed.length
  }

  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, dir, end])
}

const FAKE = Buffer.from('#!/bin/sh\necho "fake bws 2.1.0"\n')
const BIN = sha(FAKE)

const zips: Record<string, Buffer> = {
  'good.zip': zipOf([{ name: 'bws', data: FAKE }]),
  'stored.zip': zipOf([{ name: 'bws', data: FAKE, store: true }]),
  'wrong-name.zip': zipOf([{ name: 'bws2', data: FAKE }]),
  'traversal.zip': zipOf([
    { name: 'bws', data: FAKE },
    { name: '../bws', data: FAKE },
  ]),
  'folder.zip': zipOf([{ name: 'bin/bws', data: FAKE }]),
  'twice.zip': zipOf([
    { name: 'bws', data: FAKE },
    { name: 'bws', data: FAKE },
  ]),
  'other.zip': zipOf([{ name: 'bws', data: Buffer.from('#!/bin/sh\necho evil\n') }]),
}

let hits = 0
const server = createServer((req, res) => {
  hits += 1
  const path = String(req.url ?? '').slice(1)

  if (path === 'moved') {
    res.writeHead(302, { location: '/good.zip' })
    res.end()
    return
  }

  if (path === 'truncated.zip') {
    const all = zips['good.zip']
    res.writeHead(200, { 'content-length': String(all.length) })
    res.write(all.subarray(0, Math.floor(all.length / 2)))
    setTimeout(() => res.socket?.destroy(), 20)
    return
  }

  const body = zips[path]

  if (!body) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  res.writeHead(200, { 'content-length': String(body.length) })
  res.end(body)
})

await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
const port = (server.address() as any).port
const at = (path: string) => `http://127.0.0.1:${port}/${path}`

const root = mkdtempSync(join(tmpdir(), 'zone-bin-'))
let n = 0
const fresh = () => join(root, `case-${(n += 1)}`)
const list = (folder: string) =>
  existsSync(folder) ? readdirSync(folder).sort() : []

// Quiet the one stderr line a successful fetch prints, and keep it to check.
let said = ''
const write = process.stderr.write.bind(process.stderr)
const hush = () => {
  said = ''
  ;(process.stderr as any).write = (s: any) => {
    said += String(s)
    return true
  }
}
const loud = () => {
  ;(process.stderr as any).write = write
}

const refuses = async (
  what: string,
  to: Parameters<typeof vault.bws.fetch>[0],
  says: RegExp,
  left: string[] = [],
) => {
  let message = ''

  hush()
  try {
    await vault.bws.fetch(to)
  } catch (e: any) {
    message = String(e?.message ?? e)
  } finally {
    loud()
  }

  check(says.test(message), `${what}: refused (${message.split('\n')[0]})`)
  check(
    JSON.stringify(list(to.folder)) === JSON.stringify(left),
    `${what}: the folder holds ${JSON.stringify(left)} after (${JSON.stringify(list(to.folder))})`,
  )
  check(!/fetched bws/.test(said), `${what}: no "fetched" line`)
}

const good = sha(zips['good.zip'])

console.log('the pins')
{
  const rows = Object.entries(vault.bws.pins)
  check(rows.length === 6, `six platforms pinned (${rows.length})`)
  check(
    rows.every(([, p]) => /^[0-9a-f]{64}$/.test(p.zip) && /^[0-9a-f]{64}$/.test(p.bin)),
    'every row has a zip sha256 and a binary sha256',
  )
  check(
    rows.every(([k, p]) => !k.startsWith('linux') || p.triple.endsWith('-musl')),
    'linux rows are the musl builds',
  )
  check(
    vault.bws.url('aarch64-apple-darwin') ===
      'https://github.com/bitwarden/sdk-sm/releases/download/bws-v2.1.0/bws-aarch64-apple-darwin-2.1.0.zip',
    'the release URL',
  )
}

console.log('a good fetch')
{
  const folder = fresh()
  hush()
  let got = ''
  try {
    got = await vault.bws.fetch({ url: at('good.zip'), zip: good, bin: BIN, folder, name: 'bws' })
  } finally {
    loud()
  }
  check(got === join(folder, 'bws'), 'returns the binary path')
  check(sha(readFileSync(got)) === BIN, 'the bytes on disk are the fake bws')
  check(JSON.stringify(list(folder)) === '["bws"]', `only bws in the folder (${list(folder)})`)
  check(/fetched bws 2\.1\.0, verified/.test(said), 'says "fetched bws 2.1.0, verified" once')
  if (process.platform !== 'win32') {
    check((statSync(got).mode & 0o777) === 0o755, 'the binary is 0755')
    check((statSync(folder).mode & 0o777) === 0o700, 'the folder is 0700')
    check(
      execFileSync(got, { encoding: 'utf8' }).trim() === 'fake bws 2.1.0',
      'the placed binary runs',
    )
  }

  const before = hits
  hush()
  try {
    const again = await vault.bws.fetch({ url: at('good.zip'), zip: good, bin: BIN, folder, name: 'bws' })
    check(again === got, 'a second call returns the same path')
  } finally {
    loud()
  }
  check(hits === before, 'a second call makes no request')
  check(said === '', 'a second call prints nothing')

  // AN EXISTING BINARY WHOSE HASH CHANGED is refused and kept as found.
  writeFileSync(got, '#!/bin/sh\necho tampered\n')
  await refuses(
    'a changed binary on disk',
    { url: at('good.zip'), zip: good, bin: BIN, folder, name: 'bws' },
    /has changed since it was checked[\s\S]*expected sha256/,
    ['bws'],
  )
  check(
    readFileSync(got, 'utf8') === '#!/bin/sh\necho tampered\n',
    'a changed binary is left as found, never replaced or removed',
  )
  check(hits === before, 'a changed binary makes no request')
}

console.log('a redirect, and a stored entry')
{
  const folder = fresh()
  hush()
  try {
    const got = await vault.bws.fetch({ url: at('moved'), zip: good, bin: BIN, folder, name: 'bws' })
    check(sha(readFileSync(got)) === BIN, 'a redirect is followed')
  } finally {
    loud()
  }

  const stored = fresh()
  hush()
  try {
    const got = await vault.bws.fetch({
      url: at('stored.zip'), zip: sha(zips['stored.zip']), bin: BIN, folder: stored, name: 'bws',
    })
    check(sha(readFileSync(got)) === BIN, 'a stored (method 0) entry unpacks')
  } finally {
    loud()
  }
}

console.log('refusals')
await refuses(
  'the zip hash is wrong',
  { url: at('good.zip'), zip: '0'.repeat(64), bin: BIN, folder: fresh(), name: 'bws' },
  new RegExp(`not the pinned one[\\s\\S]*${'0'.repeat(64)}[\\s\\S]*${good}`),
)
await refuses(
  'the binary hash is wrong',
  { url: at('other.zip'), zip: sha(zips['other.zip']), bin: BIN, folder: fresh(), name: 'bws' },
  new RegExp(`bws inside .* is not the pinned one[\\s\\S]*${BIN}`),
)
await refuses(
  'a truncated body',
  { url: at('truncated.zip'), zip: good, bin: BIN, folder: fresh(), name: 'bws' },
  /stopped after \d+ bytes|not the pinned one/,
)
await refuses(
  'a 404',
  { url: at('nothing.zip'), zip: good, bin: BIN, folder: fresh(), name: 'bws' },
  /HTTP 404[\s\S]*Nothing was asked of the provider/,
)
await refuses(
  'the wrong entry name',
  { url: at('wrong-name.zip'), zip: sha(zips['wrong-name.zip']), bin: BIN, folder: fresh(), name: 'bws' },
  /holds no entry named bws/,
)
await refuses(
  'a path-traversal entry',
  { url: at('traversal.zip'), zip: sha(zips['traversal.zip']), bin: BIN, folder: fresh(), name: 'bws' },
  /entry with a path, "\.\.\/bws"/,
)
await refuses(
  'an entry inside a folder',
  { url: at('folder.zip'), zip: sha(zips['folder.zip']), bin: BIN, folder: fresh(), name: 'bws' },
  /entry with a path, "bin\/bws"/,
)
await refuses(
  'two entries with the name',
  { url: at('twice.zip'), zip: sha(zips['twice.zip']), bin: BIN, folder: fresh(), name: 'bws' },
  /holds 2 entries named bws/,
)

// Offline: a port nothing listens on.
{
  const closed = createServer()
  await new Promise<void>(done => closed.listen(0, '127.0.0.1', () => done()))
  const dead = (closed.address() as any).port
  await new Promise<void>(done => closed.close(() => done()))
  await refuses(
    'offline',
    { url: `http://127.0.0.1:${dead}/good.zip`, zip: good, bin: BIN, folder: fresh(), name: 'bws' },
    /could not be fetched from http:\/\/127\.0\.0\.1:\d+\/good\.zip[\s\S]*Nothing was asked of the provider/,
  )
}

console.log('ZONE_BWS picks a location, never a binary')
{
  const exit = process.exit
  const was = process.env.ZONE_BWS
  const tryBin = async (value: string) => {
    let code: number | undefined
    process.env.ZONE_BWS = value
    ;(process as any).exit = (c: number) => {
      code = c
      throw new Error('exit')
    }
    hush()
    try {
      await vault.bws.bin()
    } catch (e) {
      // the stubbed exit
    } finally {
      loud()
      ;(process as any).exit = exit
    }
    return code
  }

  const fake = join(root, 'not-bws')
  writeFileSync(fake, FAKE)
  check((await tryBin('relative/bws')) === 1 && /must be an absolute path/.test(said), 'a relative ZONE_BWS is refused')
  check((await tryBin(join(root, 'absent'))) === 1 && /no file there/.test(said), 'a missing ZONE_BWS is refused')
  check(
    (await tryBin(fake)) === 1 && /not the pinned bws 2\.1\.0[\s\S]*expected sha256/.test(said),
    'a ZONE_BWS that is not the pinned binary is refused',
  )

  if (was === undefined) {
    delete process.env.ZONE_BWS
  } else {
    process.env.ZONE_BWS = was
  }
}

// THE SYNCHRONOUS FETCH, for the `.tree` binds a caller does not wait on.
// It blocks this thread, so the server answering it must be another process:
// the one above, in this process, could never reply.
console.log('the synchronous fetch')
{
  const served = join(root, 'served')
  writeFileSync(join(root, 'good.zip'), zips['good.zip'])
  const serverCode = `
    const fs = require('node:fs')
    const body = fs.readFileSync(process.argv[1])
    const server = require('node:http').createServer((req, res) => {
      fs.appendFileSync(process.argv[2], req.url + '\\n')
      if (req.url !== '/good.zip') { res.writeHead(404); res.end('no'); return }
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'))
  `
  const { spawn } = need('node:child_process')
  const child = spawn(process.execPath, ['-e', serverCode, join(root, 'good.zip'), served], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port2: string = await new Promise(done => {
    child.stdout.once('data', (chunk: Buffer) => done(String(chunk).trim()))
  })
  const at2 = (path: string) => `http://127.0.0.1:${port2}/${path}`
  const asked = () => (existsSync(served) ? readFileSync(served, 'utf8').split('\n').filter(Boolean).length : 0)

  const folder = fresh()
  hush()
  let got = ''
  try {
    got = vault.bws.fetchNow({ url: at2('good.zip'), zip: good, bin: BIN, folder, name: 'bws' })
  } finally {
    loud()
  }
  check(got === join(folder, 'bws') && sha(readFileSync(got)) === BIN, 'fetches, checks and places the fake bws')
  check(JSON.stringify(list(folder)) === '["bws"]', `only bws in the folder (${list(folder)})`)
  check(/fetched bws 2\.1\.0, verified/.test(said), 'says "fetched bws 2.1.0, verified"')

  const before = asked()
  check(vault.bws.fetchNow({ url: at2('good.zip'), zip: good, bin: BIN, folder, name: 'bws' }) === got, 'a second call returns the same path')
  check(asked() === before, 'and makes no request')

  const refusesNow = (what: string, to: any, says: RegExp) => {
    let message = ''
    hush()
    try {
      vault.bws.fetchNow(to)
    } catch (e: any) {
      message = String(e?.message ?? e)
    } finally {
      loud()
    }
    check(says.test(message), `${what}: refused (${message.split('\n')[0]})`)
    check(JSON.stringify(list(to.folder)) === '[]', `${what}: nothing left in the folder (${JSON.stringify(list(to.folder))})`)
  }

  refusesNow('a 404', { url: at2('nothing.zip'), zip: good, bin: BIN, folder: fresh(), name: 'bws' }, /HTTP 404[\s\S]*Nothing was asked of the provider/)
  refusesNow('the zip hash is wrong', { url: at2('good.zip'), zip: '0'.repeat(64), bin: BIN, folder: fresh(), name: 'bws' }, /not the pinned one/)
  refusesNow('the binary hash is wrong', { url: at2('good.zip'), zip: good, bin: '1'.repeat(64), folder: fresh(), name: 'bws' }, /bws inside .* is not the pinned one/)

  child.kill()
}

server.close()
rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
