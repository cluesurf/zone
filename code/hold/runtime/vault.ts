// Bitwarden Secrets Manager, through one pinned `bws`, as a runtime shim.
//
// A shim rather than a module, because that is how a native reaches
// JavaScript here: `term boot` prepends the file named after the global, the
// same way `cipher` and `octets` arrive. A plain module under `code/` never
// reaches `host/`.
//
// EVERY CALL GOES THROUGH `bws` (decision 004). Zone fetches one pinned
// release per platform into its own user folder, checks it against the
// sha256 this file carries, and runs only that binary, with no shell, the
// access token in its environment and never in its arguments. The npm SDK is
// gone: a Term deck cannot depend on an npm package, and the SDK was frozen at
// 1.0.0 with no musl or Linux arm64 build.
//
// ONE EXCEPTION TO DECISION 001, AND ONLY ONE. `bws` 2.1.0 takes a written
// value only as a command-line argument (no stdin, file or environment form),
// so `zone save` puts the value in the arguments of one `bws` call, for about
// a second, where `ps` can read it. The user accepted that for `zone save`
// on the laptop, the one machine that writes (2026-11-07). The rules that
// keep it as small as it can be live in `run` and `ARGS` below: options
// before `--`, positionals after it, an edit's value as one `--value=<v>`
// argument, every `bws` error redacted before it prints. No other call puts
// a credential in an argument: reads, notes, deletes and project calls carry
// ids and names only. If `bws` gains a stdin or file form, zone moves to it
// and this exception ends.
//
// WHY NOT THE REST API. Bitwarden Secrets Manager is end to end encrypted:
// secrets are stored as `EncString` values encrypted client side with a key
// carried in the access token. Calling the API directly means owning that
// encryption. Kept open for after Term 3.0.
const vault = (() => {
  // `require` is provided by the runtime the shim is prepended into.
  const need = require

  /**
   * THE ONE SPELLING OF A KEY, and every side of this file uses it.
   *
   * A stored key is not written the way a declaration says it. The same
   * value turns up as `wikimedia-pwd`, `WIKIMEDIA_PWD` and
   * `shop:wikimedia-pwd`, because three different things have written
   * secrets here over the years. The READ path has always folded those
   * to one name; the WRITE path compared the raw string.
   *
   * THAT ASYMMETRY IS A SILENT WRONG VALUE, not a missed update. Two
   * secrets that fold to one name are both candidates on a read, and
   * the read keeps the LAST one it walks, which is whatever order the
   * provider returned. So two machines resolve the same name in the
   * same zone to DIFFERENT values, and `zone save` cannot fix it:
   * it updated the one whose raw key matched and left the other alone,
   * printing `grew` either way.
   *
   * Measured 2026-09-24. `wikimedia-pwd` read as 15 characters on a
   * laptop and 3 on the work droplet, through one zone, one project,
   * one organization, with both caches freshly fetched. A save from the
   * laptop changed nothing on the droplet. `zone wash` shows six
   * more secrets still stored in SCREAMING_SNAKE, so this is not one
   * stray row.
   *
   * Folding on both sides means a save now converges every spelling,
   * which is the only way the two can stop disagreeing.
   */
  const keyName = (raw: unknown): string => {
    const text = String(raw ?? '')
    // A `<zone>:` prefix is not part of the name.
    const cut = text.indexOf(':')
    const bare = cut > 0 ? text.slice(cut + 1) : text

    return bare.toLowerCase().split('_').join('-')
  }

  /**
   * What is worth trying again, and what is an answer.
   *
   * THE RATE LIMIT ARRIVES AS `503 Service Unavailable`, NOT `429`.
   * Measured, not assumed: `zone wash --commit` wrote 63 notes and
   * then died on a 503, which is the same "about sixty writes" the zone
   * guide records. A first version of this matched `429` and rate-limit
   * wording only, so the one status the provider actually sends went
   * straight through as fatal.
   *
   * The 5xx family and the transient socket failures are here for the
   * same reason: across nine hundred secrets, two calls each, something
   * blips. A migration that dies on one blip is a migration nobody can
   * finish.
   *
   * A refused credential, a missing secret and a malformed request are
   * NOT here. Retrying an answer ten times turns a clear failure into a
   * slow one.
   *
   * MATCHED ON THE REDACTED MESSAGE, never on `bws`'s raw stderr. clap
   * echoes argument values in its errors, so a value that happened to
   * contain `503` would otherwise turn a bad argument into ten retries.
   */
  const AGAIN =
    /\b(429|500|502|503|504)\b|rate.?limit|too many|service unavailable|temporarily|timed? ?out|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|error sending request|connection (refused|reset|closed)/i

  // A refused credential, which no retry fixes and which gets its own
  // message: the person has to check or replace the token.
  const REFUSED =
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_client|missing access token|access token is (invalid|malformed)|invalid access token/i

  const patient = async <T>(what: () => Promise<T>): Promise<T> => {
    let wait = 1000

    for (let at = 1; ; at += 1) {
      try {
        return await what()
      } catch (e: any) {
        const why = String(e?.message ?? e)

        if (at >= 10 || !AGAIN.test(why)) {
          throw e
        }

        await new Promise(rest => setTimeout(rest, wait))

        // Capped, because the point is to outlast a rate limit window,
        // not to sleep for eight minutes on the last attempt.
        wait = Math.min(wait * 2, 30000)
      }
    }
  }

  // The same, for the few calls a `.tree` file makes synchronously. The
  // wait blocks the thread, which is what a synchronous caller asked for.
  const patientNow = <T>(what: () => T): T => {
    let wait = 1000

    for (let at = 1; ; at += 1) {
      try {
        return what()
      } catch (e: any) {
        const why = String(e?.message ?? e)

        if (at >= 10 || !AGAIN.test(why)) {
          throw e
        }

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
        wait = Math.min(wait * 2, 30000)
      }
    }
  }

  /**
   * THE PINNED `bws`, fetched once and checked every time (decision 004).
   *
   * One release, one row per platform, two hashes per row: the zip as
   * Bitwarden published it, and the `bws` inside it. Both come from the
   * release's own `bws-sha256-checksums-2.1.0.txt` and the GitHub release
   * API's per-asset digest, which agreed when they were read (the zone log,
   * zone-0166). The binary hash was computed once from a verified zip.
   *
   * NEVER A `bws` FROM THE PATH. Whatever is installed there is whatever
   * version somebody installed, from wherever, and it would be handed the
   * access token. The only binary zone runs is one whose bytes match a hash
   * in this file.
   *
   * Linux uses the MUSL build everywhere. It is static, so it runs on glibc
   * hosts too (the `find` image runs it on bookworm), and zone needs no libc
   * detection.
   */
  const BWS = '2.1.0'

  const PINS: Record<
    string,
    { triple: string; zip: string; bin: string }
  > = {
    'darwin-arm64': {
      triple: 'aarch64-apple-darwin',
      zip: '9cb1c1c6e6164d83b2e339883ba02b4cbb37188ce9a484b1ce8249443163e066',
      bin: '2ab334434f09c1d4f3dcd4266661208cfc317c246fae02896163a1d93633aff8',
    },
    'darwin-x64': {
      triple: 'x86_64-apple-darwin',
      zip: '6f626b3971368902af1b9847c02791a1b4666969d7561e2047681cded7997537',
      bin: '93f3bf2c9710bec3c1a55529e2b2deef6848f7deef1207ffbbef63493fe25dd5',
    },
    'linux-x64': {
      triple: 'x86_64-unknown-linux-musl',
      zip: 'f59ee150e42b82128d437087e9bac920053c6bfddcb960d20ce9386e5ac9bba6',
      bin: 'c1e62be60735e71a82699bb7286043c6cb8b525a70f838d1fc81f10bc83f40b1',
    },
    'linux-arm64': {
      triple: 'aarch64-unknown-linux-musl',
      zip: 'eb0f1ae61d1c3b74244d2841233276e05c77e8be4da197ed90fc6248387005e1',
      bin: '9238a8f2b6749bc9d7fcd1bf663245b55d429ab93ca0c483d4bf393421dc4637',
    },
    'win32-x64': {
      triple: 'x86_64-pc-windows-msvc',
      zip: '8d6f2b51beb6f992b5b1de8b85a98bdf18de74096b724d17fa06219fc23f2bd5',
      bin: '39fdc70fe07e7d8db597eb8f7feeb285a5b320813ec5df71302f1aba98b449f4',
    },
    'win32-arm64': {
      triple: 'aarch64-pc-windows-msvc',
      zip: 'ba18adeb5d123481211c47c4e4d0ad6d81a6b0139150704785542fdee542e583',
      bin: '22c8419c4497dab5e9d0a7614a0b67e2ed2e639b577a91914ebf4094c1e72398',
    },
  }

  // Past this, a zip or the binary inside it is not `bws`. The real ones are
  // about 6 MB packed and 15 MB unpacked.
  const BWS_MOST = 64 * 1024 * 1024

  const bwsAsset = (triple: string) => `bws-${triple}-${BWS}.zip`

  const bwsUrl = (triple: string) =>
    'https://github.com/bitwarden/sdk-sm/releases/download/' +
    `bws-v${BWS}/${bwsAsset(triple)}`

  const sha256 = (bytes: Uint8Array): string =>
    need('node:crypto').createHash('sha256').update(bytes).digest('hex')

  const sha256File = (path: string): string =>
    sha256(need('node:fs').readFileSync(path))

  /**
   * The ONE entry named `name` from a zip, as bytes, or a thrown refusal.
   *
   * A reader of its own, on `node:zlib`, because GNU tar cannot read a zip
   * and an `unzip` binary is one more thing that differs per machine. It
   * reads only what a `bws` release zip is: a central directory, stored or
   * deflated entries, no encryption, no zip64. Anything else is refused, and
   * so is a zip whose entries name a folder or climb out of one, even when
   * the entry asked for is fine, because that zip is not the one Bitwarden
   * published.
   */
  const unzipOne = (zip: Uint8Array, name: string): Uint8Array => {
    const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
    const zlib = need('node:zlib')

    // The end of central directory record: 22 bytes, plus a comment of at
    // most 65535, so it is searched for backwards from the end.
    let end = -1

    for (let at = buf.length - 22; at >= 0 && at >= buf.length - 65557; at -= 1) {
      if (buf.readUInt32LE(at) === 0x06054b50) {
        end = at
        break
      }
    }

    if (end < 0) {
      throw new Error('it is not a zip (no end of central directory)')
    }

    const count = buf.readUInt16LE(end + 10)
    const size = buf.readUInt32LE(end + 12)
    const start = buf.readUInt32LE(end + 16)

    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
      throw new Error('it is a zip64 archive, which no bws release is')
    }

    if (start + size > end) {
      throw new Error('its central directory runs past its end')
    }

    const found: Array<{
      flags: number
      method: number
      packed: number
      unpacked: number
      local: number
    }> = []
    let at = start

    for (let n = 0; n < count; n += 1) {
      if (at + 46 > end || buf.readUInt32LE(at) !== 0x02014b50) {
        throw new Error('its central directory is malformed')
      }

      const nameLength = buf.readUInt16LE(at + 28)
      const extraLength = buf.readUInt16LE(at + 30)
      const commentLength = buf.readUInt16LE(at + 32)
      const entry = buf.toString('utf8', at + 46, at + 46 + nameLength)

      if (
        entry === '' ||
        entry.includes('/') ||
        entry.includes('\\') ||
        entry.includes('..')
      ) {
        throw new Error(`it holds an entry with a path, ${JSON.stringify(entry)}`)
      }

      if (entry === name) {
        found.push({
          flags: buf.readUInt16LE(at + 8),
          method: buf.readUInt16LE(at + 10),
          packed: buf.readUInt32LE(at + 20),
          unpacked: buf.readUInt32LE(at + 24),
          local: buf.readUInt32LE(at + 42),
        })
      }

      at += 46 + nameLength + extraLength + commentLength
    }

    if (found.length === 0) {
      throw new Error(`it holds no entry named ${name}`)
    }

    if (found.length > 1) {
      throw new Error(`it holds ${found.length} entries named ${name}`)
    }

    const one = found[0]

    if (one.flags & 1) {
      throw new Error(`its ${name} is encrypted`)
    }

    if (one.method !== 0 && one.method !== 8) {
      throw new Error(`its ${name} uses compression method ${one.method}`)
    }

    if (one.unpacked > BWS_MOST || one.packed > BWS_MOST) {
      throw new Error(`its ${name} is over ${BWS_MOST} bytes`)
    }

    if (
      one.local + 30 > start ||
      buf.readUInt32LE(one.local) !== 0x04034b50
    ) {
      throw new Error(`its ${name} has no local header where one should be`)
    }

    // The local header's own name and extra lengths, which may differ from
    // the central directory's. The SIZES come from the central directory,
    // since a local header written with a data descriptor carries zeros.
    const data =
      one.local +
      30 +
      buf.readUInt16LE(one.local + 26) +
      buf.readUInt16LE(one.local + 28)

    if (data + one.packed > start) {
      throw new Error(`its ${name} runs past the end of its data`)
    }

    const packed = buf.subarray(data, data + one.packed)
    const out =
      one.method === 0
        ? Buffer.from(packed)
        : zlib.inflateRawSync(packed, { maxOutputLength: BWS_MOST })

    if (out.length !== one.unpacked) {
      throw new Error(
        `its ${name} unpacked to ${out.length} bytes, not the ${one.unpacked} it declares`,
      )
    }

    return out
  }

  type Fetch = {
    url: string
    zip: string
    bin: string
    folder: string
    name: string
    timeout?: number
  }

  // The binary already at the path: kept when it matches, REFUSED when it
  // does not. A changed `bws` is not a cache miss: something rewrote a file
  // that is handed the access token. Zone does not remove it, and says where
  // it is. Empty when there is nothing there yet.
  //
  // HASHED ON EVERY FIRST USE IN A PROCESS. A 12 MB `bws` hashes in about
  // 9 ms on an M-series laptop (zone-0166, median of ten), well under the
  // 30 ms past which a size and mtime check would have been worth its
  // weaker guarantee.
  const already = (to: Fetch): string => {
    const fs = need('node:fs')
    const final = need('node:path').join(to.folder, to.name)

    if (!fs.existsSync(final)) {
      return ''
    }

    const now = sha256File(final)

    if (now === to.bin) {
      return final
    }

    throw new Error(
      `The bws at ${final} has changed since it was checked.\n\n` +
        `  expected sha256 ${to.bin}\n` +
        `  found    sha256 ${now}\n\n` +
        'Zone will not run it, and does not remove it. Look at what wrote\n' +
        'it, then remove the file, and the next zone command fetches and\n' +
        'checks a fresh copy.',
    )
  }

  // Check a downloaded zip and place the `bws` inside it. Synchronous, so
  // the async fetch and the synchronous one share it.
  const place = (to: Fetch, zipTemp: string, binTemp: string, got: number) => {
    const fs = need('node:fs')
    const final = need('node:path').join(to.folder, to.name)
    const zipHash = sha256File(zipTemp)

    if (zipHash !== to.zip) {
      throw new Error(
        `The zip from ${to.url} is not the pinned one.\n\n` +
          `  expected sha256 ${to.zip}\n` +
          `  received sha256 ${zipHash} (${got} bytes)\n\n` +
          'Nothing was kept, and nothing was asked of the provider.',
      )
    }

    let body: Uint8Array

    try {
      body = unzipOne(fs.readFileSync(zipTemp), to.name)
    } catch (e: any) {
      throw new Error(
        `The zip from ${to.url} matched its pin, but ${e.message}. Nothing was kept.`,
      )
    }

    const binHash = sha256(body)

    if (binHash !== to.bin) {
      throw new Error(
        `The ${to.name} inside ${to.url} is not the pinned one.\n\n` +
          `  expected sha256 ${to.bin}\n` +
          `  unpacked sha256 ${binHash}\n\n` +
          'Nothing was kept, and nothing was asked of the provider.',
      )
    }

    fs.writeFileSync(binTemp, body, { flag: 'wx', mode: 0o600 })

    if (process.platform !== 'win32') {
      fs.chmodSync(binTemp, 0o755)
    }

    fs.renameSync(binTemp, final)
    process.stderr.write(`fetched bws ${BWS}, verified\n`)

    return final
  }

  const temps = (to: Fetch) => {
    const path = need('node:path')
    const stamp = `${process.pid}-${need('node:crypto').randomBytes(6).toString('hex')}`

    return {
      zipTemp: path.join(to.folder, `.fetch-${stamp}.zip`),
      binTemp: path.join(to.folder, `.fetch-${stamp}.bin`),
    }
  }

  const gone = (file: string) => {
    try {
      need('node:fs').unlinkSync(file)
    } catch (e) {
      // already absent
    }
  }

  /**
   * Fetch, check and place one `bws`. Returns its path, or throws a refusal
   * whose message says what was wrong. Hashes are not secrets, so they are
   * named.
   *
   * EVERYTHING IS AN ARGUMENT, so the tests drive this against a local
   * server and a fake binary with hashes of their own. Nothing that ships
   * reaches it except through `bin` below, with the pins.
   *
   * NOTHING IS LEFT BEHIND ON A REFUSAL. The zip goes to a temp file in the
   * same folder, created 0600, and so does the binary, which is renamed into
   * place only once its hash matches, so a half-written or wrong `bws` is
   * never at the final path. A rename within one folder is atomic, which is
   * also why two processes fetching at once cannot leave one torn file.
   */
  const fetchBws = async (to: Fetch): Promise<string> => {
    const fs = need('node:fs')
    const here = already(to)

    if (here) {
      return here
    }

    fs.mkdirSync(to.folder, { recursive: true, mode: 0o700 })

    const { zipTemp, binTemp } = temps(to)

    try {
      let res: any

      try {
        res = await fetch(to.url, {
          redirect: 'follow',
          headers: { 'user-agent': `zone/bws-${BWS}` },
          signal: AbortSignal.timeout(to.timeout ?? 60000),
        })
      } catch (e: any) {
        throw new Error(
          `bws could not be fetched from ${to.url}\n\n` +
            `  ${String(e?.cause?.message ?? e?.message ?? e)}\n\n` +
            'Nothing was asked of the provider. Connect, and run the command\n' +
            'again: bws is fetched once and kept.',
        )
      }

      if (!res.ok || !res.body) {
        throw new Error(
          `bws could not be fetched from ${to.url}: HTTP ${res.status}.\n` +
            'Nothing was asked of the provider.',
        )
      }

      // STREAMED to disk, never held twice.
      const fd = fs.openSync(zipTemp, 'wx', 0o600)
      let got = 0

      try {
        for await (const chunk of res.body) {
          got += chunk.length

          if (got > BWS_MOST) {
            throw new Error(`the zip at ${to.url} is over ${BWS_MOST} bytes`)
          }

          fs.writeSync(fd, chunk)
        }
      } catch (e: any) {
        throw new Error(
          `bws from ${to.url} stopped after ${got} bytes: ` +
            String(e?.cause?.message ?? e?.message ?? e),
        )
      } finally {
        fs.closeSync(fd)
      }

      return place(to, zipTemp, binTemp, got)
    } finally {
      gone(zipTemp)
      gone(binTemp)
    }
  }

  // The download alone, as a program of its own, for the synchronous fetch.
  // A LITERAL, never a function turned back into source: the bundle may
  // rename what a function closes over, and this must run as written. It
  // writes the body to the temp file it is given and nothing else, and every
  // check stays in this process, in `place`.
  const DOWNLOAD = `
const [url, out, wait, most, agent] = process.argv.slice(1)
const fs = require('node:fs')
;(async () => {
  let res
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': agent }, signal: AbortSignal.timeout(Number(wait)) })
  } catch (e) {
    process.stderr.write(String((e && e.cause && e.cause.message) || (e && e.message) || e))
    process.exit(2)
  }
  if (!res.ok || !res.body) {
    process.stderr.write(String(res.status))
    process.exit(3)
  }
  const fd = fs.openSync(out, 'wx', 0o600)
  let got = 0
  try {
    for await (const chunk of res.body) {
      got += chunk.length
      if (got > Number(most)) throw new Error('the zip at ' + url + ' is over ' + most + ' bytes')
      fs.writeSync(fd, chunk)
    }
  } catch (e) {
    process.stderr.write(got + ' ' + String((e && e.cause && e.cause.message) || (e && e.message) || e))
    process.exit(4)
  } finally {
    fs.closeSync(fd)
  }
  process.stdout.write(String(got))
})()
`

  /**
   * `fetchBws`, for a caller that cannot wait: the `.tree` binds that are
   * synchronous (`good`, `read`, `make`). The download runs in a child
   * `node`, which this process blocks on, and the zip is checked and placed
   * here, by the same `place`. Same refusals, same messages.
   */
  const fetchBwsNow = (to: Fetch): string => {
    const fs = need('node:fs')
    const here = already(to)

    if (here) {
      return here
    }

    fs.mkdirSync(to.folder, { recursive: true, mode: 0o700 })

    const { zipTemp, binTemp } = temps(to)

    try {
      const ran = need('node:child_process').spawnSync(
        process.execPath,
        [
          '-e',
          DOWNLOAD,
          to.url,
          zipTemp,
          String(to.timeout ?? 60000),
          String(BWS_MOST),
          `zone/bws-${BWS}`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: (to.timeout ?? 60000) + 10000,
          windowsHide: true,
        },
      )
      const said = String(ran.stderr ?? '').trim()

      if (ran.status === 3) {
        throw new Error(
          `bws could not be fetched from ${to.url}: HTTP ${said}.\n` +
            'Nothing was asked of the provider.',
        )
      }

      if (ran.status === 4) {
        const cut = said.indexOf(' ')

        throw new Error(
          `bws from ${to.url} stopped after ${said.slice(0, cut)} bytes: ${said.slice(cut + 1)}`,
        )
      }

      if (ran.status !== 0) {
        throw new Error(
          `bws could not be fetched from ${to.url}\n\n` +
            `  ${said || String(ran.error?.message ?? `exit ${ran.status ?? ran.signal}`)}\n\n` +
            'Nothing was asked of the provider. Connect, and run the command\n' +
            'again: bws is fetched once and kept.',
        )
      }

      return place(to, zipTemp, binTemp, Number(ran.stdout) || 0)
    } finally {
      gone(zipTemp)
      gone(binTemp)
    }
  }

  /**
   * Where the verified `bws` for this machine is, or comes from.
   *
   * It lives in zone's user folder, `~/.base/@term/zone/bws/<version>/
   * <triple>/` (on Windows under `%USERPROFILE%`). `ZONE_BWS` may name
   * another location, for an image that places the binary itself, and that
   * file is checked against the same pin: the variable picks where, never
   * which.
   */
  const where = () => {
    const key = `${process.platform}-${process.arch}`
    const pin = PINS[key]

    if (!pin) {
      process.stderr.write(
        `Zone has no pinned bws for this platform (${key}).\n\n` +
          `bws ${BWS} is pinned for: ${Object.keys(PINS).join(', ')}.\n` +
          'Zone never runs a bws from the PATH. Nothing was asked of the\n' +
          'provider.\n',
      )
      process.exit(1)
    }

    const path = need('node:path')
    const chosen = process.env.ZONE_BWS ?? ''

    return {
      pin,
      chosen,
      fetch: {
        url: bwsUrl(pin.triple),
        zip: pin.zip,
        bin: pin.bin,
        folder: path.join(
          need('node:os').homedir(),
          '.base',
          '@term',
          'zone',
          'bws',
          BWS,
          pin.triple,
        ),
        name: process.platform === 'win32' ? 'bws.exe' : 'bws',
      },
    }
  }

  const checkChosen = (chosen: string, pin: { bin: string }): string => {
    const fs = need('node:fs')

    if (!need('node:path').isAbsolute(chosen)) {
      throw new Error(`ZONE_BWS must be an absolute path, not ${chosen}`)
    }

    if (!fs.existsSync(chosen)) {
      throw new Error(`ZONE_BWS names ${chosen}, and there is no file there`)
    }

    const now = sha256File(chosen)

    if (now !== pin.bin) {
      throw new Error(
        `ZONE_BWS names ${chosen}, which is not the pinned bws ${BWS}.\n\n` +
          `  expected sha256 ${pin.bin}\n` +
          `  found    sha256 ${now}`,
      )
    }

    return chosen
  }

  // ONE CHECK PER PROCESS AND LOCATION. A `zone wash` makes two calls per
  // secret across nine hundred of them, and hashing 12 MB each time would
  // add seconds for nothing: the file was checked by this process a moment
  // ago. Keyed by where it is, so pointing ZONE_BWS elsewhere checks again.
  let checked = { at: '', path: '' }

  /**
   * The path of the verified `bws` for this machine, fetching it the first
   * time. Refuses, and exits, on any mismatch.
   */
  const bin = async (): Promise<string> => {
    const at = where()
    const key = at.chosen || at.fetch.folder

    if (checked.at === key) {
      return checked.path
    }

    try {
      const path = at.chosen
        ? checkChosen(at.chosen, at.pin)
        : await fetchBws(at.fetch)

      checked = { at: key, path }

      return path
    } catch (e: any) {
      process.stderr.write(`${e?.message ?? e}\n`)
      process.exit(1)
    }
  }

  // The same, without waiting, for the synchronous `.tree` binds.
  const binNow = (): string => {
    const at = where()
    const key = at.chosen || at.fetch.folder

    if (checked.at === key) {
      return checked.path
    }

    try {
      const path = at.chosen
        ? checkChosen(at.chosen, at.pin)
        : fetchBwsNow(at.fetch)

      checked = { at: key, path }

      return path
    } catch (e: any) {
      process.stderr.write(`${e?.message ?? e}\n`)
      process.exit(1)
    }
  }

  /**
   * EVERY ARGUMENT LIST ZONE HANDS `bws`, in one place, as data.
   *
   * The rules, because a written value is now an argument:
   *
   *   - OPTIONS BEFORE `--`, POSITIONALS AFTER IT. A key, value or id that
   *     starts with `-` is then never read as a flag.
   *   - AN OPTION'S VALUE IS JOINED, `--note=<n>`, never two arguments, for
   *     the same reason.
   *   - An edit's value goes last among the options, as `--value=<v>`
   *     (decision 004). `secret create` has no `--value` in 2.1.0, only the
   *     `<VALUE>` positional, so there it goes after `--`, which a leading
   *     `-` cannot escape either.
   *   - `--output json` on every call, so what comes back is parsed, never
   *     scraped.
   *   - THE TOKEN IS NEVER HERE. It goes in `BWS_ACCESS_TOKEN`, in the
   *     child's environment.
   */
  const ARGS = {
    projects: () => ['project', 'list', '--output', 'json'],
    project: (id: string) => ['project', 'get', '--output', 'json', '--', id],
    makeProject: (name: string) => [
      'project',
      'create',
      '--output',
      'json',
      '--',
      name,
    ],
    list: (project = '') =>
      project
        ? ['secret', 'list', '--output', 'json', '--', project]
        : ['secret', 'list', '--output', 'json'],
    get: (id: string) => ['secret', 'get', '--output', 'json', '--', id],
    create: (key: string, value: string, note: string, project: string) => [
      'secret',
      'create',
      `--note=${note}`,
      '--output',
      'json',
      '--',
      key,
      value,
      project,
    ],
    edit: (
      id: string,
      key: string,
      value: string,
      note: string,
      project: string,
    ) => [
      'secret',
      'edit',
      `--key=${key}`,
      `--note=${note}`,
      `--project-id=${project}`,
      '--output',
      'json',
      `--value=${value}`,
      '--',
      id,
    ],
    note: (id: string, note: string) => [
      'secret',
      'edit',
      `--note=${note}`,
      '--output',
      'json',
      '--',
      id,
    ],
    drop: (ids: string[]) => [
      'secret',
      'delete',
      '--output',
      'json',
      '--',
      ...ids,
    ],
  }

  /**
   * Every occurrence of a hidden string replaced with `<value>`.
   *
   * clap ECHOES argument values in its errors (`invalid value '<v>' for
   * '<VALUE>'`), so a `bws` error from a write can carry the value itself.
   * This runs on every message before anything reads it, the retry test
   * included. Each hidden string is also matched as JSON escapes it and line
   * by line, because a multi-line value can come back split or escaped.
   *
   * A value under four characters cannot be replaced without mangling the
   * rest of the message (a `0` inside `503`), so a message that holds one is
   * withheld whole instead.
   */
  const redact = (text: string, hidden: string[]): string => {
    let out = String(text ?? '')
    const forms: string[] = []

    for (const one of hidden) {
      if (!one) {
        continue
      }

      if (one.length < 4) {
        if (out.includes(one)) {
          return '(the provider message is withheld, because it would show the value)'
        }

        continue
      }

      forms.push(one, JSON.stringify(one).slice(1, -1))

      for (const line of one.split(/\r?\n/)) {
        if (line.trim().length >= 4) {
          forms.push(line)
        }
      }
    }

    forms.sort((a, b) => b.length - a.length)

    for (const form of forms) {
      out = out.split(form).join('<value>')
    }

    return out
  }

  /**
   * Whether a command line fits where it will run. Windows `CreateProcess`
   * caps one at 32,767 characters, counted after quoting, so zone refuses
   * past 32,000 there rather than let the call fail halfway with a message
   * that may echo the value. macOS and Linux allow far more than the
   * provider stores.
   */
  const WINDOWS_MOST = 32000

  const fits = (
    binary: string,
    args: string[],
    platform: string = process.platform,
  ): boolean => {
    if (platform !== 'win32') {
      return true
    }

    const length = [binary, ...args].reduce(
      (sum, one) => sum + one.length + 3 + (one.match(/["\\]/g)?.length ?? 0),
      0,
    )

    return length <= WINDOWS_MOST
  }

  // THE CHILD'S ENVIRONMENT IS A SHORT LIST, never the parent's whole one.
  // A zone command runs with whatever the shell had, other credentials
  // included, and `bws` needs none of them: a path, a home for its config, a
  // locale, the proxy settings, the system root Windows' network stack
  // needs, a server override, and the token.
  const KEEP = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
    'ALL_PROXY',
    'all_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'BWS_SERVER_URL',
  ]

  const envFor = (token: string): Record<string, string> => {
    const env: Record<string, string> = {}

    for (const name of KEEP) {
      const value = process.env[name]

      if (value !== undefined) {
        env[name] = value
      }
    }

    env.BWS_ACCESS_TOKEN = token

    return env
  }

  type Run = {
    // What the call is for, named in a refusal: `write database-url`.
    what?: string
    // Strings that must never reach a message: the value of a write.
    hidden?: string[]
  }

  // One failed call, as an Error whose message is ALREADY REDACTED. Built
  // from `bws`'s stderr only, never from the error Node makes, whose message
  // repeats the whole command line, value included.
  const failure = (
    e: any,
    stderr: string,
    token: string,
    args: string[],
    how: Run,
  ): Error => {
    const timed =
      e?.code === 'ETIMEDOUT' || e?.signal === 'SIGKILL' || e?.killed === true
    const raw = timed
      ? 'the provider did not answer within 20 seconds (timed out)'
      : String(stderr || e?.code || 'bws failed and said nothing')
    const said = redact(raw, [token, ...(how.hidden ?? [])])
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .slice(0, 3)
      .join('\n  ')
    const code = typeof e?.status === 'number' ? e.status : e?.code
    const out: any = new Error(
      `bws could not ${how.what ?? `${args[0]} ${args[1]}`} (exit ${code ?? e?.signal ?? '?'}): ${said}`,
    )

    out.said = said
    out.refused = REFUSED.test(said) && !AGAIN.test(said)

    return out
  }

  const tooLong = (binary: string, args: string[], how: Run) => {
    if (fits(binary, args)) {
      return
    }

    process.stderr.write(
      `${how.what ?? 'This call'}: the command line would pass ${WINDOWS_MOST} ` +
        'characters, the most Windows runs. Nothing was written. bws takes a\n' +
        'written value only as an argument, so a value this long cannot be\n' +
        'saved from Windows. Save it from macOS or Linux.\n',
    )
    process.exit(1)
  }

  /**
   * THE ONE RUNNER. `bws` with no shell, `--output json`, the token in its
   * environment and nothing else from this one, retried on a transient
   * failure. Answers stdout. Throws an Error whose message is redacted.
   */
  const run = async (
    args: string[],
    token: string,
    how: Run = {},
  ): Promise<string> => {
    const binary = await bin()
    const cp = need('node:child_process')

    tooLong(binary, args, how)

    return patient(
      () =>
        new Promise<string>((done, refuse) => {
          const child = cp.execFile(
            binary,
            args,
            {
              env: envFor(token),
              encoding: 'utf8',
              maxBuffer: 32 * 1024 * 1024,
              timeout: 20000,
              killSignal: 'SIGKILL',
              windowsHide: true,
            },
            (e: any, stdout: string, stderr: string) => {
              if (e) {
                refuse(failure(e, stderr, token, args, how))
              } else {
                done(stdout)
              }
            },
          )

          child.stdin?.end()
        }),
    )
  }

  const runNow = (args: string[], token: string, how: Run = {}): string => {
    const binary = binNow()
    const cp = need('node:child_process')

    tooLong(binary, args, how)

    return patientNow(() => {
      try {
        return cp.execFileSync(binary, args, {
          env: envFor(token),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 32 * 1024 * 1024,
          timeout: 20000,
          killSignal: 'SIGKILL',
          windowsHide: true,
        })
      } catch (e: any) {
        throw failure(e, String(e?.stderr ?? ''), token, args, how)
      }
    })
  }

  // What a person reads when the provider refused, and what to do. Exits.
  const refusal = (e: any): never => {
    const why = String(e?.said ?? e?.message ?? e)

    process.stderr.write(
      e?.refused
        ? 'The provider refused the credential.\n\n  ' +
            why +
            '\n\nThe credential may be wrong, expired or revoked. Check it with\n' +
            '`zone code show` and replace it with `zone code save`.\n'
        : AGAIN.test(why)
          ? 'The provider did not answer, after ten tries.\n\n  ' +
            why +
            '\n\nTHE CREDENTIAL IS NOT THE PROBLEM: this is the provider\n' +
            'or the network. Try again shortly.\n'
          : 'The provider refused.\n\n  ' +
            why +
            '\n\n' +
            (/plan|limit|maximum|quota|upgrade/i.test(why)
              ? 'That is a limit on the account, not a problem with the credential.\n'
              : 'The credential may be wrong, expired or revoked. Check it with\n' +
                '`zone code show`, replace it with `zone code save`.\n'),
    )
    process.exit(1)
  }

  // A refused CREDENTIAL ends the command with that message: no caller can
  // do anything better with it. Every other failure is thrown to the caller,
  // as the SDK's were.
  const guard = <A extends unknown[], T>(
    what: (...args: A) => Promise<T>,
  ): ((...args: A) => Promise<T>) => async (...args: A) => {
    try {
      return await what(...args)
    } catch (e: any) {
      if (e?.refused) {
        refusal(e)
      }

      throw e
    }
  }

  type Secret = {
    id: string
    key: string
    value: string
    note: string
    projectId: string
  }

  const secretOf = (one: any): Secret => ({
    id: String(one?.id ?? ''),
    key: String(one?.key ?? ''),
    value: String(one?.value ?? ''),
    note: String(one?.note ?? ''),
    projectId: String(one?.projectId ?? ''),
  })

  // Every secret the credential can see, or every one in one project. ONE
  // CALL: `secret list` carries key, value, note and project together, which
  // ends the SDK's list-then-fetch split and its notes-only-on-the-fetch
  // trap.
  const listed = async (token: string, project = ''): Promise<Secret[]> =>
    (JSON.parse(await run(ARGS.list(project), token)) ?? []).map(secretOf)

  const projectList = async (
    token: string,
  ): Promise<Array<{ name: string; body: string }>> =>
    (JSON.parse(await run(ARGS.projects(), token)) ?? []).map((one: any) => ({
      name: String(one?.name ?? ''),
      body: String(one?.id ?? ''),
    }))

  // A bind is a project id in `note` mode and a project NAME in `project`
  // mode, and `bws` takes ids only. Empty when it names neither.
  const idOf = (
    projects: Array<{ name: string; body: string }>,
    bind: string,
  ): string =>
    projects.find(one => one.body === bind)?.body ??
    projects.find(one => one.name === bind)?.body ??
    ''

  return {
    // The pinned `bws`: `bin` is what every caller uses. `fetch`, `unzip`
    // and `pins` are here for the tests and for the one-off check that the
    // pins still equal the release's own checksums. `args`, `redact` and
    // `fits` are the argument rules, as pure functions the tests hold.
    bws: {
      version: BWS,
      pins: PINS,
      url: bwsUrl,
      bin,
      binNow,
      fetch: fetchBws,
      fetchNow: fetchBwsNow,
      unzip: unzipOne,
      args: ARGS,
      redact,
      fits,
      keep: KEEP,
    },

    // THE SYNCHRONOUS FOUR, for `hold/bitwarden.tree` binds that a `.tree`
    // caller does not wait on. Through the same pinned `bws` and the same
    // rules: no `bws` from the PATH, ever.
    now: {
      // Whether this machine can reach the provider: whether a `bws` is
      // pinned for it. Nothing is fetched or run.
      open: (): boolean => Boolean(PINS[`${process.platform}-${process.arch}`]),

      // Whether the credential opens the project. No values are read.
      good: (token: string, bind: string): boolean => {
        try {
          const projects = JSON.parse(runNow(ARGS.projects(), token)) ?? []
          const id = idOf(
            projects.map((one: any) => ({
              name: String(one?.name ?? ''),
              body: String(one?.id ?? ''),
            })),
            bind,
          )

          if (!id) {
            return false
          }

          runNow(ARGS.project(id), token)

          return true
        } catch (e) {
          return false
        }
      },

      // Every secret in one project, as name, value and note. The caller
      // narrows to what the declaration asked for.
      read: (
        token: string,
        bind: string,
      ): Array<{ name: string; body: string; note: string }> => {
        try {
          const projects = (JSON.parse(runNow(ARGS.projects(), token)) ?? []).map(
            (one: any) => ({
              name: String(one?.name ?? ''),
              body: String(one?.id ?? ''),
            }),
          )
          const id = idOf(projects, bind)

          if (!id) {
            return []
          }

          return (JSON.parse(runNow(ARGS.list(id), token)) ?? []).map(
            (one: any) => ({
              name: keyName(one?.key),
              body: String(one?.value ?? ''),
              note: String(one?.note ?? ''),
            }),
          )
        } catch (e) {
          return refusal(e)
        }
      },

      // Create a project, named after the zone path. Its id.
      make: (token: string, name: string): string => {
        try {
          return String(
            JSON.parse(runNow(ARGS.makeProject(name), token))?.id ?? '',
          )
        } catch (e) {
          return refusal(e)
        }
      },
    },

    // The note already stored against one name, empty when there is no
    // such secret.
    //
    // NOTHING HERE READS THE NOTE'S STRUCTURE. The note format has one
    // set of readers, `note-value` / `note-lists` / `note-with` in
    // `code/tool/base.tree`, and the caller composes with those. A
    // second reader in here would be a second implementation of the
    // grammar, which disagrees with the first eventually and does it
    // silently.
    note: guard(
      async (token: string, org: string, name: string): Promise<string> => {
        const want = keyName(name)
        const found = (await listed(token)).find(one => keyName(one.key) === want)

        return found?.note ?? ''
      },
    ),

    // Every secret's NAME AND NOTE.
    //
    // `secret list` carries values too, so values cross this function. They
    // are dropped on the next line and never returned, but the plain
    // statement is that this HOLDS them briefly, exactly as `zone read`
    // does. It is not a value-free operation.
    notes: guard(
      async (
        token: string,
        org: string,
      ): Promise<Array<{ name: string; note: string }>> =>
        (await listed(token)).map(one => ({ name: one.key, note: one.note })),
    ),

    // Replace one secret's NOTE, leaving its value exactly as it was.
    //
    // NO VALUE IS SENT. `bws secret edit` keeps every field it is not
    // given, so `--note` alone changes the note and nothing else, and the
    // value never goes on a command line. The SDK's `update` replaced the
    // whole secret, which is why this used to read the value and write it
    // back.
    //
    // A secret that is not there is not an error. `wash` walks what the
    // provider listed, and a name removed between the listing and the
    // write is a race, not a fault.
    mark: guard(
      async (
        token: string,
        org: string,
        name: string,
        note: string,
      ): Promise<boolean> => {
        const want = keyName(name)
        const found = (await listed(token)).find(one => keyName(one.key) === want)

        if (!found) {
          return false
        }

        await run(ARGS.note(found.id, note), token, { what: `mark ${name}` })

        return true
      },
    ),

    // EVERY STORED COPY OF ONE NAME: its id, its note and the NAME of its
    // project. Metadata only, never a value.
    //
    // A KEY IS NOT UNIQUE, AND IN `note` MODE THAT IS THE DESIGN. A name
    // declared at `shop` and overridden under `shop/moon` is two secrets
    // under one key, told apart by their notes (`list zone, <shop>` and
    // `list zone, <shop/moon>`), and the read path seals each zone from
    // the copy whose note names it. So a writer must pick the copy it
    // means BY ITS NOTE, and the note's grammar lives in
    // `code/tool/note.tree`, not here. This hands the caller every copy
    // and lets the caller choose, by id.
    copies: guard(
      async (
        token: string,
        org: string,
        name: string,
      ): Promise<Array<{ body: string; note: string; bank: string }>> => {
        const want = keyName(name)
        const found = (await listed(token)).filter(
          one => keyName(one.key) === want,
        )

        if (found.length === 0) {
          return []
        }

        const nameOf = new Map<string, string>()

        for (const one of await projectList(token)) {
          nameOf.set(one.body, one.name)
        }

        return found.map(one => ({
          body: one.id,
          note: one.note,
          bank: nameOf.get(one.projectId) ?? one.projectId,
        }))
      },
    ),

    // Write one secret: the copies named by `ids` are updated, and when
    // `ids` is empty a new one is created.
    //
    // THE ONE CALL THAT PUTS A VALUE IN AN ARGUMENT (decision 004, the
    // exception to 001). `bws` takes it no other way. It goes last among an
    // edit's options as `--value=<v>`, or after `--` for a create, and every
    // error from these calls is redacted before it prints. It is never
    // formatted into a message, never logged, and never written to a file.
    //
    // ONLY THE COPIES THE CALLER NAMED. This used to update every secret
    // under the key, which is right for one name stored under several
    // spellings and catastrophic for a name that two zones keep apart: a
    // save meant for `shop/moon` overwrote production's `database-url`
    // with the development pool on 2026-10-14. The caller picks the
    // copies whose note names the zone being written (`work/one.tree`,
    // `own-copies`), which still converges `WIKIMEDIA_PWD` and
    // `wikimedia-pwd` when both belong to that zone.
    //
    // AN UPDATE KEEPS EACH COPY'S OWN NOTE. The note may name
    // a second declaration (`zone share`), and replacing it with the one
    // being written would drop that reader. `note` is used only for a
    // created copy.
    //
    // THE MODE DECIDES WHERE IT GOES, and both have to work, exactly as
    // they do on the read side. `bank` is the project NAME to file
    // under: the zone path in `project` mode, the one declared project
    // in `note` mode. `zone` is the path that goes on the note.
    //
    // The note arrives already composed. Writing `''` here would file a
    // secret in `note` mode with nothing saying which zone owns it, leaving
    // it present at the provider and invisible to every reader.
    put: guard(
      async (
        token: string,
        org: string,
        bank: string,
        note: string,
        name: string,
        value: string,
        ids: string[] = [],
      ): Promise<string> => {
        const project =
          (await projectList(token)).find(one => one.name === bank)?.body ?? ''

        if (!project) {
          process.stderr.write(
            `No project called ${bank} at the provider.\n\n` +
              'In `note` mode that is the one project the declaration names\n' +
              'on its `base` block. In `project` mode it is one project per\n' +
              'zone, and `zone save --commit` creates them.\n',
          )
          process.exit(1)
        }

        const how = { what: `write ${name}`, hidden: [value] }

        // EVERY NAMED COPY IS UPDATED, NOT THE FIRST.
        //
        // Updating one of several copies that belong to the same zone
        // leaves the others holding the old value, and the read path keeps
        // the LAST candidate it walks rather than the one just written, so
        // the save silently does nothing observable. Writing all of THAT
        // ZONE'S copies converges it whatever the reader picks. Another
        // zone's copy under the same key is never in `ids`, and is never
        // touched.
        const want = new Set(ids.map(String))
        const found = want.size
          ? (await listed(token)).filter(one => want.has(one.id))
          : []

        // AN ID THAT IS GONE IS A RACE, not a create. Filing a fresh copy
        // because the one asked for vanished between the listing and the
        // write would put a second value where the caller meant to replace
        // one.
        if (want.size && found.length !== want.size) {
          process.stderr.write(
            `${name}: ${want.size - found.length} of the copies to update ` +
              'are no longer at the provider. Nothing was written. Run the ' +
              'save again.\n',
          )
          process.exit(1)
        }

        if (found.length) {
          // SAID OUT LOUD, because a silent convergence hides the defect
          // that made it necessary. `wikimedia-pwd` and `WIKIMEDIA_PWD` are
          // one name to every reader and two rows in the vault, and until
          // this line printed them the only symptom was two machines
          // disagreeing about a value with no way to tell why.
          if (found.length > 1) {
            const spellings = [...new Set(found.map(one => one.key))]

            process.stderr.write(
              `${name} is stored ${found.length} times for this zone,\n` +
                `under ${spellings.length} spelling(s): ${spellings.join(', ')}\n` +
                'All of them were just written, so every reader of this zone\n' +
                'now agrees.\n\n' +
                'Two copies of ONE zone are a defect: a read keeps whichever\n' +
                'the provider listed last, which is why a saved value could\n' +
                'appear not to take effect on one machine while working on\n' +
                'another. (Copies that belong to OTHER zones are by design and\n' +
                'were not touched.)\n',
            )
          }

          // THE PROJECT IS THE ONE BEING WRITTEN TO, not the copy's own.
          // The read path fetches only the declared project in `note` mode,
          // so a copy left in another project is a value no reader sees.
          // Keeping the copy's project was tried, and `test/save.sh` caught
          // it: a fixture copy filed in a stale per-zone project went on
          // reading as unsealed after a save that reported `grew`.
          //
          // EACH CALL IS RETRIED, by `run`. A blip halfway through
          // convergence leaves the spellings disagreeing again, which is the
          // exact state this loop exists to end.
          for (const one of found) {
            await run(
              ARGS.edit(one.id, name, value, one.note, project),
              token,
              how,
            )
          }

          return 'grew'
        }

        await run(ARGS.create(name, value, note, project), token, how)

        return 'made'
      },
    ),

    // Remove the copies named by `ids`, and nothing else. How many went.
    //
    // By id, never by key, for the same reason `put` is: the first copy
    // under a key may be another zone's, and removing a development
    // override by name could remove production's value instead.
    drop: guard(
      async (token: string, org: string, ids: string[]): Promise<number> => {
        if (ids.length === 0) {
          return 0
        }

        const here = new Set((await listed(token)).map(one => one.id))
        const going = ids.map(String).filter(id => here.has(id))

        if (going.length === 0) {
          return 0
        }

        await run(ARGS.drop(going), token, { what: 'remove secrets' })

        return going.length
      },
    ),

    // EVERY SECRET ASKED FOR, with its value and its note.
    //
    // ONE CALL PER PROJECT ASKED FOR, together, so a tree with eight zones
    // waits for one round trip rather than eight. With no projects named it
    // is one call for everything the credential can see.
    //
    // ONLY THE PROJECTS ASKED FOR. `secret list -- <project>` returns that
    // project's secrets alone, so naming one zone never pulls every value
    // in the organization into this process.
    //
    // WHAT `binds` HOLDS DEPENDS ON THE MODE, and both have to work.
    // `note` mode passes the one project's ID. `project` mode passes the
    // zone PATH, which is the project's name. `bws` takes ids only, so the
    // project list turns a name into an id, and each row comes back under
    // the bind it was asked for, which is what the caller groups by.
    //
    // A project that fails is empty rather than fatal: the caller refuses on
    // a missing required name, and that message names the value, which is
    // more use than a provider error naming a project. A refused CREDENTIAL
    // is still fatal, through `guard`, because it fails the project list
    // first.
    all: guard(
      async (
        token: string,
        org: string,
        // The projects asked for. Empty means all of them.
        binds: string[] = [],
      ): Promise<
        Array<{ name: string; body: string; note: string; bind: string }>
      > => {
        if (binds.length === 0) {
          return (await listed(token)).map(one => ({
            name: keyName(one.key),
            body: one.value,
            note: one.note,
            bind: one.projectId,
          }))
        }

        const projects = await projectList(token)
        const each = await Promise.all(
          binds.map(async bind => {
            const id = idOf(projects, String(bind))

            if (!id) {
              return []
            }

            try {
              return (await listed(token, id)).map(one => ({
                name: keyName(one.key),
                body: one.value,
                note: one.note,
                bind: String(bind),
              }))
            } catch (e: any) {
              if (e?.refused) {
                throw e
              }

              return []
            }
          }),
        )

        return each.flat()
      },
    ),

    // One copy's value, by id. Empty if it is not there. By id, because
    // the first copy under a key may belong to another zone.
    one: guard(
      async (token: string, org: string, id: string): Promise<string> => {
        if (!id) {
          return ''
        }

        try {
          return secretOf(JSON.parse(await run(ARGS.get(id), token))).value
        } catch (e: any) {
          if (!e?.refused && /\b404\b|not found/i.test(String(e?.said ?? ''))) {
            return ''
          }

          throw e
        }
      },
    ),

    // Every project the credential can see, as name and id pairs. The
    // organization is the one the token belongs to: `bws` takes none.
    projects: guard(
      async (
        token: string,
        org: string,
      ): Promise<Array<{ name: string; body: string }>> => projectList(token),
    ),
  }
})()
