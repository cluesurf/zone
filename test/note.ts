// The secret note: written as `host` data, read by the compiler.
//
//   pnpm exec tsx test/note.ts        (from the zone package)
//
// THE POINT OF THIS SUITE is that the note is parsed by the Term
// compiler through the mill, not by a line reader. So the cases that
// matter are the ones a line reader got wrong: several values on one
// line, a value carrying a comma or a colon, and a note a person has
// typed extra lines into.
//
// It also holds the TRANSITION. A note written in the retired
// `zone: a, b` shape still has to resolve until `zone wash` has
// rewritten them all, and the day that stops working is the day every
// shared secret reads as missing from one of its two declarations.

// The globals `term boot` prepends, installed by hand. FIRST, before any
// import of ../host/**. See test/shim.ts.
import './shim'

const { noteZones, noteHas, noteMake, noteAdd, notePlain } = await import(
  '../host/code/tool/note'
)

let failed = 0

function check(what: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)

  if (a === b) {
    console.log(`  ok    ${what}`)
    return
  }

  failed += 1
  console.log(`  FAIL  ${what}`)
  console.log(`        got  ${a}`)
  console.log(`        want ${b}`)
}

console.log('\nwriting')

check('one zone', noteMake(['acme']), 'list zone, <acme>')
check(
  'two zones',
  noteMake(['acme', 'shop']),
  'list zone, <acme>, <shop>',
)
check('no zones', noteMake([]), 'list zone')

console.log('\nreading what it wrote')

check('one back', noteZones(noteMake(['acme'])), ['acme'])

// THE CASE A LINE READER LOST. zone's hand-rolled `.tree` reader kept
// ONE `<...>` per line, so a two-value line silently dropped the first.
// That bug is why `time <made>, <toss>` read as a cache with no fetch
// time. The compiler keeps every value, and this is the guard on it.
check('two back', noteZones(noteMake(['acme', 'shop'])), [
  'acme',
  'shop',
])

check('none back', noteZones(noteMake([])), [])

check('a nested path', noteZones(noteMake(['base/word.surf/star'])), [
  'base/word.surf/star',
])

console.log('\nmembership')

const two = noteMake(['acme', 'shop'])

check('names the first', noteHas(two, 'acme'), true)
check('names the second', noteHas(two, 'shop'), true)
check('does not name a third', noteHas(two, 'land'), false)

// A PREFIX IS NOT A MEMBER. `shop` must not match `shop/moon`, or a
// value scoped to development would be handed to production.
check('a prefix is not a member', noteHas(two, 'mes'), false)
check(
  'a longer path is not a member',
  noteHas(two, 'shop/moon'),
  false,
)

console.log('\nadding, never replacing')

// THE SHARE CASE. One stored value can belong to two declarations, and
// rewriting the note to the single zone being filed under drops the
// other, so every shared name reads as missing on the next read from
// the other root.
check(
  'keeps what was there',
  noteZones(noteAdd(noteMake(['acme']), 'shop')),
  ['acme', 'shop'],
)

check(
  'adding twice changes nothing',
  noteZones(noteAdd(noteMake(['acme', 'shop']), 'shop')),
  ['acme', 'shop'],
)

check('adding to an empty note', noteZones(noteAdd('', 'acme')), [
  'acme',
])

console.log('\nthe retired shape still resolves')

// Until `zone wash --commit` has rewritten every stored note.
check('one zone, old shape', noteZones('zone: acme'), ['acme'])

check('two zones, old shape', noteZones('zone: acme, shop'), [
  'acme',
  'shop',
])

check(
  'old shape with the fields that are now dropped',
  noteZones('zone: acme, shop\nenv: ARCJET_KEY\nfrom: shop/.env'),
  ['acme', 'shop'],
)

check('old shape membership', noteHas('zone: acme, shop', 'shop'), true)

// MIGRATING ONE NOTE IS `noteAdd` ON IT. Reading the old shape and
// writing the new one is the whole of what `zone wash` does per
// secret, so it is proven here rather than only in the command.
check(
  'old shape migrates to new',
  noteAdd('zone: acme, shop\nfrom: shop/.env', 'acme'),
  'list zone, <acme>, <shop>',
)

console.log('\nwhat may be rewritten, and what may not')

// THE GUARD BETWEEN A MIGRATION AND SOMEBODY'S WRITING. `note-make`
// emits one line, so rewriting a note with it drops everything else.
// That is right for the four machine-written lines and wrong for
// anything a person typed.
check('a new-shape note', notePlain('list zone, <acme>'), true)
check('an old-shape note', notePlain('zone: acme, shop'), true)

// `env` and `from` are machine fields this migration exists to DROP. A
// version that counted them as writing reported 870 of 878 notes as
// untouchable, so the migration could not have moved anything.
check(
  'the retired machine fields',
  notePlain('zone: acme\nenv: ARCJET_KEY\nfrom: shop/.env'),
  true,
)

check(
  'a line somebody wrote',
  notePlain('zone: acme\nservice: Google Cloud Platform'),
  false,
)

check(
  'a sentence somebody wrote',
  notePlain('zone: acme\nrotate this before March'),
  false,
)

check('prose alone', notePlain('the oauth client for sign-in'), false)

// An empty note has no line that is not machine-written, so it passes
// this guard. It is stopped by the OTHER one: naming no zone at all.
check('empty', notePlain(''), true)
check('and empty names no zone', noteZones(''), [])

console.log('\nnotes a person typed in')

// A note is a person's field first, so anything unparseable must yield
// no zones rather than throwing. A command that dies on a note somebody
// wrote a sentence into is worse than one that reports it unowned.
check('empty', noteZones(''), [])
check('prose only', noteZones('the oauth client for sign-in'), [])
check('a colon in prose', noteZones('note: rotate this in March'), [])

console.log('')

if (failed) {
  console.log(`${failed} failed\n`)
  process.exit(1)
}

console.log('all ok\n')
