// Every vault method, through the runner, against the fake `bws`.
//
//   pnpm exec tsx test/vault.ts
//
// A real token would test Bitwarden. This tests OUR code: the exact
// arguments every call hands `bws`, that a written value travels in one
// argument and nowhere else, that every value shape survives byte for byte,
// that an error echoing a value is redacted, that the child gets a short
// environment, that an existing name is updated rather than duplicated, that
// a missing project is refused before anything is written, and that delete
// removes only what was asked for.
//
// The fake (test/fixture/bin/bws) keeps its secrets in store.json beside it
// and records every argv in argv.jsonl, so "the value was in one argument"
// is asserted rather than assumed. It is reached by evaluating vault.ts with
// this platform's binary pin replaced by the fake's hash (test/fake-bws.mjs),
// so the real pin check runs and nothing that ships is bypassed.
import { createRequire } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypes } from './strip'
import { pinFake, shaOf } from './fake-bws.mjs'

const need = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'zone-vault-'))
const dir = join(root, 'bws')
const fake = join(dir, 'bws')

mkdirSync(dir)
copyFileSync('test/fixture/bin/bws', fake)
chmodSync(fake, 0o755)
process.env.ZONE_BWS = fake

// A variable the child must never see: the short environment list.
process.env.ZONE_TEST_CANARY = 'must-not-reach-bws'

const source = pinFake(readFileSync('code/hold/runtime/vault.ts', 'utf8'), shaOf(fake))
const vault = new Function('require', `${stripTypes(source)}; return vault`)(need) as any

type Row = { id: string; key: string; value: string; note?: string; projectId?: string }

const at = (name: string) => join(dir, name)
const store = (): Row[] =>
  existsSync(at('store.json')) ? JSON.parse(readFileSync(at('store.json'), 'utf8')) : []
const setStore = (rows: Row[]) =>
  writeFileSync(at('store.json'), JSON.stringify(rows, null, 2) + '\n')
const calls = (): string[] =>
  existsSync(at('calls.log')) ? readFileSync(at('calls.log'), 'utf8').split('\n').filter(Boolean) : []
const argvs = (): Array<{ argv: string[]; env: string[] }> =>
  existsSync(at('argv.jsonl'))
    ? readFileSync(at('argv.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []
const clear = () => {
  for (const name of ['calls.log', 'argv.jsonl', 'fail.json']) {
    rmSync(at(name), { force: true })
  }
}

let pass = 0
let fail = 0
const ok = (w: string) => { console.log(`  ok    ${w}`); pass += 1 }
const no = (w: string) => { console.log(`  FAIL  ${w}`); fail += 1 }
const check = (cond: boolean, w: string) => (cond ? ok(w) : no(w))

// A call that is expected to EXIT: the exit code and what it printed.
const exits = async (what: () => Promise<unknown> | unknown) => {
  const exit = process.exit
  const write = process.stderr.write.bind(process.stderr)
  let code: number | undefined
  let said = ''

  ;(process as any).exit = (c: number) => {
    code = c
    throw new Error('exited')
  }
  ;(process.stderr as any).write = (s: any) => {
    said += String(s)
    return true
  }

  try {
    await what()
  } catch (e) {
    // the stubbed exit, or a throw
  } finally {
    ;(process as any).exit = exit
    ;(process.stderr as any).write = write
  }

  return { code, said }
}

// Quiet stderr around a call that warns, keeping what it said.
const hushed = async <T>(what: () => Promise<T>) => {
  const write = process.stderr.write.bind(process.stderr)
  let said = ''

  ;(process.stderr as any).write = (s: any) => {
    said += String(s)
    return true
  }

  try {
    return { got: await what(), said }
  } finally {
    ;(process.stderr as any).write = write
  }
}

const put = (a: {
  bank?: string
  note?: string
  name: string
  value: string
  ids?: string[]
  token?: string
}) =>
  vault.put(a.token ?? 'tok', 'org', a.bank ?? 'base', a.note ?? '', a.name, a.value, a.ids ?? [])

const idsOf = (key: string) => store().filter(one => one.key === key).map(one => one.id)

const NOTE = 'list zone, <cluesurf>'

console.log('the argument rules, as data')
{
  const A = vault.bws.args
  const create = A.create('k', '-v', 'n', 'p') as string[]
  const edit = A.edit('id', 'k', '-v', 'n', 'p') as string[]
  const dash = (args: string[]) => args.indexOf('--')

  check(
    JSON.stringify(create) === JSON.stringify(['secret', 'create', '--note=n', '--output', 'json', '--', 'k', '-v', 'p']),
    'create: options, then --, then key, value, project',
  )
  check(
    JSON.stringify(edit) ===
      JSON.stringify(['secret', 'edit', '--key=k', '--note=n', '--project-id=p', '--output', 'json', '--value=-v', '--', 'id']),
    'edit: the value is ONE --value=<v> argument, the last option before --',
  )
  check(dash(edit) === edit.length - 2 && edit[dash(edit) - 1] === '--value=-v', 'edit: only the id follows --')
  check(
    JSON.stringify(A.note('id', '-n')) === JSON.stringify(['secret', 'edit', '--note=-n', '--output', 'json', '--', 'id']),
    'mark: a note alone, never a value',
  )
  check(
    JSON.stringify(A.drop(['a', '-b'])) === JSON.stringify(['secret', 'delete', '--output', 'json', '--', 'a', '-b']),
    'delete: every id after --',
  )
  check(
    JSON.stringify(A.list('-p')) === JSON.stringify(['secret', 'list', '--output', 'json', '--', '-p']) &&
      JSON.stringify(A.list()) === JSON.stringify(['secret', 'list', '--output', 'json']),
    'list: a project after --, or none',
  )
  check(
    Object.values(A).every((make: any) => {
      const args = make('x', 'y', 'z', 'w', 'v') as string[]
      return args.includes('--output') && args[args.indexOf('--output') + 1] === 'json'
    }),
    'every call carries --output json',
  )
  check(!vault.bws.keep.some((name: string) => /TOKEN|SECRET|KEY|PASS/i.test(name)), 'the kept environment names no credential')
}

console.log('the Windows command line limit')
{
  const long = 'x'.repeat(35000)
  check(!vault.bws.fits('C:\\bws.exe', vault.bws.args.edit('id', 'k', long, 'n', 'p'), 'win32'), 'a 35,000 character value does not fit on Windows')
  check(vault.bws.fits('/bws', vault.bws.args.edit('id', 'k', long, 'n', 'p'), 'darwin'), 'and fits on macOS')
  check(vault.bws.fits('C:\\bws.exe', vault.bws.args.edit('id', 'k', 'short', 'n', 'p'), 'win32'), 'a short value fits on Windows')
}

console.log('redaction')
{
  const r = vault.bws.redact
  check(r("error: invalid value 'hunter22' for '<VALUE>'", ['hunter22']) === "error: invalid value '<value>' for '<VALUE>'", 'a value is replaced')
  check(!r('a "line one\\nline two" b', ['line one\nline two']).includes('line one'), 'a JSON-escaped multi-line value is replaced')
  check(!r('got: line two only', ['line one\nline two']).includes('line two'), 'one line of a multi-line value is replaced')
  check(/withheld/.test(r('[503] 0 bytes', ['0'])), 'a message holding a value under four characters is withheld whole')
  check(r('[503] Service Unavailable', ['zz']) === '[503] Service Unavailable', 'a short value that is absent changes nothing')
}

console.log('a new name, and its update')
setStore([])
clear()
{
  const first = await put({ note: NOTE, name: 'database-url', value: 'the-actual-secret-value' })
  check(first === 'made', `a new name is created (${first})`)
  const made = store()[0]
  check(made?.projectId === 'p-base', 'into the project it was told')
  check(made?.note === NOTE, 'the note is written with it')
  const write = argvs().find(a => a.argv[1] === 'create')
  check(
    JSON.stringify(write?.argv) ===
      JSON.stringify(['secret', 'create', `--note=${NOTE}`, '--output', 'json', '--', 'database-url', 'the-actual-secret-value', 'p-base']),
    'the exact create arguments',
  )
  check(
    argvs().filter(a => a.argv.join('\u0000').includes('the-actual-secret-value')).length === 1,
    'the value is in exactly one call',
  )
  check(!calls().join('\n').includes('the-actual-secret-value'), 'the call log never holds it')

  const env = argvs()[0]?.env ?? []
  check(env.includes('BWS_ACCESS_TOKEN'), 'the token arrives in the environment')
  check(!env.includes('ZONE_TEST_CANARY'), 'and nothing else the parent held')
  check(!argvs().some(a => a.argv.includes('tok')), 'the token is in no argument')

  clear()
  const again = await put({ note: 'list zone, <other>', name: 'database-url', value: 'a-new-value', ids: idsOf('database-url') })
  check(again === 'grew', 'an existing name is updated')
  check(store().length === 1, 'and not duplicated')
  check(store()[0]?.note === NOTE, 'an update keeps the copy\'s own note')
  const edit = argvs().find(a => a.argv[1] === 'edit')
  check(
    JSON.stringify(edit?.argv) ===
      JSON.stringify(['secret', 'edit', '--key=database-url', `--note=${NOTE}`, '--project-id=p-base', '--output', 'json', '--value=a-new-value', '--', made.id]),
    'the exact edit arguments',
  )
}

console.log('every value shape, byte for byte')
for (const [label, value] of [
  ['empty', ''],
  ['a leading dash', '-leading'],
  ['a leading double dash', '--value=sneaky'],
  ['a newline', 'line one\nline two\n'],
  ['an equals sign', 'a=b=c'],
  ['quotes and backslashes', `he said "hi" it's \\back\\ \\"`],
  ['unicode', 'héllo ✓ 日本語 🔑'],
  ['35,000 characters', 'y'.repeat(35000)],
] as Array<[string, string]>) {
  setStore([])
  clear()
  const made = await put({ note: NOTE, name: 'shape', value })
  const id = idsOf('shape')[0] ?? ''
  const back = await vault.one('tok', 'org', id)
  const grew = await put({ note: NOTE, name: 'shape', value: value + '|2', ids: [id] })
  const after = await vault.one('tok', 'org', id)
  check(
    made === 'made' && back === value && grew === 'grew' && after === value + '|2' && store().length === 1,
    `${label}: created, read back, updated, read back`,
  )
}

console.log('an error that echoes the value is redacted')
setStore([])
clear()
{
  let message = ''
  try {
    await put({ name: 'echo-the-value', value: 'super-secret-value-123' })
  } catch (e: any) {
    message = String(e?.message ?? e)
  }
  check(message !== '' && !message.includes('super-secret-value-123'), `the message holds no value (${message.split('\n')[0]})`)
  check(/<value>/.test(message), 'it says where the value was')
  check(/write echo-the-value/.test(message) && /exit 2/.test(message), 'it names the key and the exit code')

  let multi = ''
  try {
    await put({ name: 'echo-the-value', value: 'first line here\nsecond line here' })
  } catch (e: any) {
    multi = String(e?.message ?? e)
  }
  check(!/first line here|second line here/.test(multi), 'a multi-line value is redacted too')

  let short = ''
  try {
    await put({ name: 'echo-the-value', value: 'abc' })
  } catch (e: any) {
    short = String(e?.message ?? e)
  }
  check(!short.includes("'abc'") && /withheld/.test(short), 'a short value withholds the message')
}

console.log('a missing project is refused before anything is written')
{
  setStore([])
  clear()
  const { code, said } = await exits(() => put({ bank: 'nowhere', name: 'x', value: 'y' }))
  check(code === 1 && /No project called nowhere/.test(said), 'refused, naming the project')
  check(store().length === 0, 'and nothing was written')
}

console.log('delete, and reading one back')
{
  setStore([
    { id: 's-a', key: 'database-url', value: 'gone', note: NOTE, projectId: 'p-base' },
    { id: 's-9', key: 'other', value: 'keep', note: NOTE, projectId: 'p-base' },
  ])
  clear()
  const gone = await vault.drop('tok', 'org', ['s-a', 's-not-there'])
  check(gone === 1, 'delete reports what it removed')
  check(store().length === 1 && store()[0]?.key === 'other', 'and removed only that one')
  check(
    JSON.stringify(argvs().find(a => a.argv[1] === 'delete')?.argv) ===
      JSON.stringify(['secret', 'delete', '--output', 'json', '--', 's-a']),
    'the exact delete arguments, present ids only',
  )
  check((await vault.drop('tok', 'org', [])) === 0, 'no ids, no call')
  check((await vault.one('tok', 'org', 's-9')) === 'keep', 'one name reads back')
  check((await vault.one('tok', 'org', 's-absent')) === '', 'a missing id reads as empty')
  check((await vault.one('tok', 'org', '')) === '', 'an empty id reads as empty')
}

console.log('notes and mark')
{
  setStore([
    { id: 's-a', key: 'alpha', value: 'AAA', note: 'list zone, <cluesurf>', projectId: 'p-base' },
    { id: 's-b', key: 'beta', value: 'BBB', note: 'zone: shop', projectId: 'p-base' },
  ])
  clear()
  const listed = await vault.notes('tok', 'org')
  check(listed.length === 2, 'notes lists every secret')
  check(listed.find((o: any) => o.name === 'beta')?.note === 'zone: shop', 'notes carries the note')
  check(!JSON.stringify(listed).includes('AAA'), 'notes returns no value')
  check((await vault.note('tok', 'org', 'BETA')) === 'zone: shop', 'note finds a name by its folded spelling')
  check((await vault.note('tok', 'org', 'nothing')) === '', 'note of a missing name is empty')

  clear()
  const marked = await vault.mark('tok', 'org', 'beta', 'list zone, <shop>')
  const after = store().find(o => o.key === 'beta')
  check(marked === true, 'mark reports what it changed')
  check(after?.note === 'list zone, <shop>', 'mark rewrote the note')
  check(after?.value === 'BBB', 'mark left the value untouched')
  check(after?.projectId === 'p-base', 'mark left the project untouched')
  check(!argvs().some(a => a.argv.join('\u0000').includes('BBB')), 'mark put no value in any argument')
  check((await vault.mark('tok', 'org', 'not-there', 'x')) === false, 'mark on a missing name is not an error')
}

console.log('a rate limit is waited out, and nothing else is')
{
  clear()
  writeFileSync(at('fail.json'), JSON.stringify({ times: 2, stderr: 'Error: Received error message from server: [503 Service Unavailable]' }))
  const waited = await vault.mark('tok', 'org', 'alpha', 'list zone, <land>')
  check(waited === true && calls().filter(l => l.startsWith('failed')).length === 2, 'mark waits out two 503s and then writes')
  check(store().find(o => o.key === 'alpha')?.note === 'list zone, <land>', 'and the write landed after the wait')

  clear()
  writeFileSync(at('fail.json'), JSON.stringify({ times: 99, stderr: 'Error: [400 Bad Request] the request was malformed', code: 1 }))
  let gaveUp = false
  try {
    await vault.mark('tok', 'org', 'alpha', 'x')
  } catch {
    gaveUp = true
  }
  check(gaveUp && calls().filter(l => l.startsWith('failed')).length === 1, 'an answer is not retried: one call, then it gives up')
  rmSync(at('fail.json'), { force: true })
}

console.log('a refused credential')
{
  clear()
  const { code, said } = await exits(() => vault.notes('bad', 'org'))
  check(code === 1 && /refused the credential/.test(said) && /zone code save/.test(said), 'says the credential was refused, and how to replace it')
  check(calls().filter(l => l.startsWith('refused')).length === 1, 'and asked once, never retried')
  check(!said.includes('bad '), 'the token is not printed')
}

console.log('one name, several spellings')
{
  setStore([
    { id: 's-k1', key: 'kilo-key', value: 'NEW', note: 'zone: shop', projectId: 'p-base' },
    { id: 's-k2', key: 'KILO_KEY', value: 'OLD', note: 'zone: shop', projectId: 'p-base' },
    { id: 's-k3', key: 'shop:kilo-key', value: 'OLDER', note: 'zone: shop', projectId: 'p-base' },
  ])
  const { got, said } = await hushed(() =>
    put({ note: 'list zone, <shop>', name: 'kilo-key', value: 'CONVERGED', ids: ['s-k1', 's-k2', 's-k3'] }),
  )
  check(got === 'grew', 'a name under three spellings updates rather than creates')
  check(/stored 3 times/.test(said), 'and says it was stored three times')
  check(store().length === 3, 'no fourth copy was created')
  check(store().every(one => one.value === 'CONVERGED'), 'every spelling now holds the saved value')
  const read = (await vault.all('tok', 'org', [])).filter((one: any) => one.name === 'kilo-key')
  check(read.length === 3 && read.every((one: any) => one.body === 'CONVERGED'), 'the read folds all three to one name with one value')

  const { code } = await exits(() =>
    put({ note: 'list zone, <shop>', name: 'kilo-key', value: 'X', ids: ['s-k1', 's-gone'] }),
  )
  check(code === 1 && store().every(one => one.value === 'CONVERGED'), 'an id that is gone is refused, and nothing is written')
}

console.log('one key, two zones')
{
  setStore([
    { id: 's-prod', key: 'database-url', value: 'PROD', note: 'list zone, <shop>', projectId: 'p-base' },
    { id: 's-moon', key: 'database-url', value: 'MOON', note: 'list zone, <shop/moon>', projectId: 'p-base' },
  ])
  const both = await vault.copies('tok', 'org', 'database-url')
  check(both.length === 2 && both.every((one: any) => one.bank === 'base'), 'copies lists every copy under a key, with its project name')
  check(both.find((one: any) => one.body === 's-moon')?.note === 'list zone, <shop/moon>', 'copies carries each note')
  check(!/PROD|MOON/.test(JSON.stringify(both)), 'copies returns no value')
  check((await vault.copies('tok', 'org', 'none-such')).length === 0, 'copies of a missing name is empty')

  const moon = await put({ note: 'list zone, <shop/moon>', name: 'database-url', value: 'MOON-2', ids: ['s-moon'] })
  check(moon === 'grew', 'a zone with its own copy updates it')
  check(store().find(o => o.id === 's-prod')?.value === 'PROD', 'the other zone\'s copy keeps its value')
  check(store().find(o => o.id === 's-prod')?.note === 'list zone, <shop>', 'and keeps its note')
  check(store().find(o => o.id === 's-moon')?.value === 'MOON-2', 'the named copy holds the new value')

  setStore([{ id: 's-prod', key: 'database-url', value: 'PROD', note: 'list zone, <shop>', projectId: 'p-base' }])
  const fresh = await put({ note: 'list zone, <shop/moon>', name: 'database-url', value: 'MOON', ids: [] })
  check(fresh === 'made' && store().length === 2, 'a zone with no copy gets a new one beside the other zone\'s')
  check(store().find(o => o.id === 's-prod')?.value === 'PROD', 'and production is untouched')
}

console.log('a read asks only for the projects named')
{
  setStore([
    { id: 's-1', key: 'database-url', value: 'from-base', note: 'zone: base', projectId: 'p-base' },
    { id: 's-2', key: 'GOOGLE_CLIENT_ID', value: 'from-wordsurf', note: 'zone: base/word.surf', projectId: 'p-word' },
    { id: 's-3', key: 'sentry-dsn', value: 'from-star', note: 'zone: base/word.surf/star', projectId: 'p-star' },
  ])
  clear()
  const named = await vault.all('tok', 'org', ['base', 'p-word', 'not-a-project'])
  check(named.length === 2, `a name and an id both resolve, and an unknown one is empty (${named.length} rows)`)
  check(named.find((o: any) => o.name === 'database-url')?.bind === 'base', 'each row comes back under the bind it was asked for')
  check(named.find((o: any) => o.name === 'google-client-id')?.body === 'from-wordsurf', 'keys are folded')
  check(!calls().some(l => l.startsWith('secret list p-star')) && !calls().some(l => l.startsWith('secret list all')), 'the unnamed project was never listed')

  const everything = await vault.all('tok', 'org', [])
  check(everything.length === 3 && everything.find((o: any) => o.name === 'sentry-dsn')?.bind === 'p-star', 'no binds reads everything, under its project id')
  const projects = await vault.projects('tok', 'org')
  check(projects.some((p: any) => p.name === 'base' && p.body === 'p-base'), 'projects lists name and id pairs')
}

console.log('the synchronous binds')
{
  check(vault.now.open() === Boolean(vault.bws.pins[`${process.platform}-${process.arch}`]), 'open: whether a bws is pinned here')
  check(vault.now.good('tok', 'base') === true && vault.now.good('tok', 'p-base') === true, 'good: a project by name or id')
  check(vault.now.good('tok', 'nowhere') === false, 'good: an unknown project is false')
  check(vault.now.good('bad', 'base') === false, 'good: a refused credential is false, not an exit')
  const read = vault.now.read('tok', 'cluesurf-talk-development')
  check(Array.isArray(read) && read.length === 0, 'read: a project with nothing in it is empty')
  const base = vault.now.read('tok', 'base')
  check(base.length === 1 && base[0].name === 'database-url' && base[0].body === 'from-base', 'read: one project, folded')
  const id = vault.now.make('tok', 'base/new-zone')
  check(/^p-/.test(id), `make: a project is created and its id returned (${id})`)
  const { code, said } = await exits(() => vault.now.read('bad', 'base'))
  check(code === 1 && /refused the credential/.test(said), 'read: a refused credential exits, saying so')
}

rmSync(root, { recursive: true, force: true })

console.log('')
console.log(fail === 0 ? `  every vault check passed (${pass})` : `  ${fail} failed, ${pass} passed`)
process.exit(fail === 0 ? 0 : 1)
