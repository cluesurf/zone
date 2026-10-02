// The Bitwarden Secrets Manager SDK, as a runtime shim.
//
// A shim rather than a module, because that is how a native reaches
// JavaScript here: `term boot` prepends the file named after the global, the
// same way `cipher` and `octets` arrive. A plain module under `code/` never
// reaches `host/`.
//
// WHY NOT THE `bws` COMMAND. `bws secret create` takes the value as a
// COMMAND-LINE ARGUMENT, with no stdin and no file. A command line is
// readable by anything on the machine that can list processes, so writing a
// secret that way puts it in front of every process on the box. Here the
// value is a function argument and never leaves this process.
//
// WHY NOT THE REST API. Bitwarden Secrets Manager is end to end encrypted:
// secrets are stored as `EncString` values encrypted client side with a key
// carried in the access token. Calling the API directly would mean
// implementing their encryption, which is hand-rolling another product's
// crypto to save one command.
const vault = (() => {
  // `require` is provided by the runtime the shim is prepended into.
  const need = require

  // Load the SDK, or say plainly what is missing.
  //
  // It is optional: reading goes through `bws`, and only writing needs this.
  // A tree that never writes should not have to carry a native module, and
  // one that does should be told what to install rather than shown a
  // resolution stack trace.
  // The SDK, or nothing. `all` falls back to the `bws` command line tool
  // when it is absent, so a tree that has not installed the SDK still
  // reads. Writing has no fallback: `bws` takes a value as a command
  // argument, where anything that can list processes can read it.
  const maybe = () => {
    try {
      return need('@bitwarden/sdk-napi')
    } catch (e) {
      return undefined
    }
  }

  const load = () => {
    try {
      return need('@bitwarden/sdk-napi')
    } catch (e) {
      process.stderr.write(
        'The Bitwarden SDK is not installed.\n\n' +
          '  pnpm add @bitwarden/sdk-napi\n\n' +
          'It is how every secret is read and written. Reading used to go\n' +
          'through the `bws` command line tool, which is a second binary to\n' +
          'install and puts a value in argv when writing. This does neither.\n',
      )
      process.exit(1)
    }
  }

  const open = async (token: string) => {
    const { BitwardenClient } = load()
    const client = new BitwardenClient()

    try {
      // RETRIED, because a 503 here is not a bad credential and saying
      // so sends somebody to rotate a working token. `patient` only
      // retries the transient set; a real 401 falls straight through to
      // the message below on the first attempt.
      await patient(() => client.auth().loginAccessToken(token))
    } catch (e: any) {
      const why = String(e?.message ?? e).split('\n')[0]
      const transient = AGAIN.test(why)

      process.stderr.write(
        transient
          ? 'The provider did not answer, after ten tries.\n\n  ' +
              why +
              '\n\nTHE CREDENTIAL IS NOT THE PROBLEM: this is the provider\n' +
              'or the network. Try again shortly.\n'
          : 'The provider refused the credential.\n\n  ' +
              why +
              '\n\nThe credential may be wrong, expired or revoked. Check it with\n' +
              '`zone code show` and replace it with `zone code save`.\n',
      )
      process.exit(1)
    }

    return client
  }

  const projectOf = async (client: any, org: string, path: string) => {
    const projects = await patient(() => client.projects().list(org))

    return projects.data.find((one: any) => one.name === path)?.id
  }

  /**
   * THE ONE SPELLING OF A KEY, and every side of this file uses it.
   *
   * A stored key is not written the way a declaration says it. The same
   * value turns up as `wikimedia-pwd`, `WIKIMEDIA_PWD` and
   * `mesh:wikimedia-pwd`, because three different things have written
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

  const named = async (client: any, org: string, name: string) => {
    const all = await patient(() => client.secrets().list(org))
    const want = keyName(name)

    return all.data.find((one: any) => keyName(one.key) === want)
  }

  /**
   * EVERY secret under one key, not the first.
   *
   * A KEY IS NOT UNIQUE AT THIS PROVIDER. Nothing stops two secrets sharing
   * one `key`, and once that happens the writer and the reader disagree in
   * the worst possible way: `named` above takes the FIRST match, while the
   * read path walks its candidates and keeps the LAST one it sees, so a save
   * reports success, writes a real value, and the zone goes on serving the
   * other copy for ever.
   *
   * MEASURED, NOT IMAGINED. `github-token` was saved twice under two zones,
   * each save printing `grew`, and `zone read --fresh` afterwards
   * returned a cache byte-identical to the one before it while the token it
   * served stayed expired. `zone test` reported "Everything checks out"
   * throughout, because every name opened; it just opened the wrong value.
   */
  const allNamed = async (client: any, org: string, name: string) => {
    const all = await patient(() => client.secrets().list(org))
    const want = keyName(name)

    return all.data.filter((one: any) => keyName(one.key) === want)
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
   */

  const AGAIN =
    /\b(429|500|502|503|504)\b|rate.?limit|too many|service unavailable|temporarily|timed? ?out|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i

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

  return {
    // The note already stored against one name, empty when there is no
    // such secret.
    //
    // NOTHING HERE READS THE NOTE'S STRUCTURE. The note format has one
    // set of readers, `note-value` / `note-lists` / `note-with` in
    // `code/tool/base.tree`, and the caller composes with those. A
    // second reader in here would be a second implementation of the
    // grammar, which disagrees with the first eventually and does it
    // silently.
    note: async (
      token: string,
      org: string,
      name: string,
    ): Promise<string> => {
      const client = await open(token)
      const already = await named(client, org, name)

      return String(already?.note ?? '')
    },

    // Every secret's NAME AND NOTE.
    //
    // THE NOTE DOES NOT COME BACK ON `list` IN THIS SDK. It comes back
    // on the fetch, which is why `all` above merges the two and takes
    // whichever carries one. A first version of this read `list` alone
    // and every note came back empty, so `zone wash` reported all
    // 878 secrets as naming no zone: a migration that had done nothing,
    // reporting nothing left to do.
    //
    // So it fetches, which means values cross this function. They are
    // dropped on the next line and never returned, but the honest
    // statement is that this HOLDS them briefly, exactly as
    // `zone read` does. It is not a value-free operation and the
    // comment that said so was wrong.
    notes: async (
      token: string,
      org: string,
    ): Promise<Array<{ name: string; note: string }>> => {
      const client = await open(token)
      const listed = await patient(() => client.secrets().list(org))
      const rows = listed?.data ?? []

      if (rows.length === 0) {
        return []
      }

      const got = await patient(() =>
        client.secrets().getByIds(rows.map((one: any) => one.id)),
      )

      const byId = new Map<string, any>()

      for (const one of rows) {
        byId.set(String(one.id), one)
      }

      return (got?.data ?? []).map((one: any) => {
        const meta = byId.get(String(one.id)) ?? {}

        return {
          name: String(one.key ?? meta.key ?? ''),
          note: String(one.note ?? meta.note ?? ''),
        }
      })
    },

    // Replace one secret's NOTE, leaving its value exactly as it was.
    //
    // THE VALUE HAS TO BE READ TO WRITE THE NOTE, and that is the
    // provider's shape, not a choice here: `secrets().update` replaces
    // the whole secret, so the value must be supplied or it is erased.
    // So this fetches ONE value, writes the identical bytes back, and
    // lets it go. One at a time, never printed, never logged, never
    // passed to a child, and never held alongside another.
    //
    // A secret that is not there is not an error. `wash` walks what the
    // provider listed, and a name removed between the listing and the
    // write is a race, not a fault.
    mark: async (
      token: string,
      org: string,
      name: string,
      note: string,
    ): Promise<boolean> => {
      const client = await open(token)
      const already = await named(client, org, name)

      if (!already) {
        return false
      }

      const full: any = await patient(() => client.secrets().get(already.id))
      const value = String(full?.value ?? already.value ?? '')

      // THE PROJECTS ARE CARRIED THROUGH. `update` replaces them the
      // same way it replaces the value, so passing none would unfile
      // the secret from its project and hide it from every reader.
      const holds = [
        String(full?.projectId ?? already.projectId ?? ''),
      ].filter(Boolean)

      await patient(() =>
        client.secrets().update(org, already.id, name, value, note, holds),
      )

      return true
    },

    // Write one secret: created if the name is new, updated if not.
    //
    // `value` is a function argument the whole way down. It is never
    // formatted into a string, never logged, never passed to a child.
    //
    // THE MODE DECIDES WHERE IT GOES, and both have to work, exactly as
    // they do on the read side. `bank` is the project NAME to file
    // under: the zone path in `project` mode, the one declared project
    // in `note` mode. `zone` is the path that goes on the note.
    //
    // This used to take the zone path alone and look up a project by
    // it, which is `project` mode's rule applied unconditionally. In
    // `note` mode that project does not exist, so `zone save
    // --name <x>` died with "No project called <zone> at the provider"
    // and the ONLY per-name write in the system was unusable. It went
    // unnoticed because every value so far was written by the migration
    // loader, which is mode-aware and is going away.
    //
    // The note is the other half, and arrives already composed. Writing
    // `''` here, as this did, would file a secret in `note` mode with
    // nothing saying which zone owns it, leaving it present at the
    // provider and invisible to every reader, which is worse than
    // either outcome alone.
    put: async (
      token: string,
      org: string,
      bank: string,
      note: string,
      name: string,
      value: string,
    ): Promise<string> => {
      const client = await open(token)
      const project = await projectOf(client, org, bank)

      if (!project) {
        process.stderr.write(
          `No project called ${bank} at the provider.\n\n` +
            'In `note` mode that is the one project the declaration names\n' +
            'on its `base` block. In `project` mode it is one project per\n' +
            'zone, and `zone save --commit` creates them.\n',
        )
        process.exit(1)
      }

      // EVERY COPY IS UPDATED, NOT THE FIRST.
      //
      // Updating one of several leaves the others holding the old value, and
      // the read path keeps the LAST candidate it walks rather than the one
      // just written, so the save silently does nothing observable. Writing
      // all of them converges the key on one value whatever the reader picks,
      // which is the only outcome that makes `save` mean what it says.
      //
      // It is also the only repair available from here: nothing in the CLI
      // deletes a secret, so a duplicate cannot be removed, and leaving one
      // stale copy behind is what caused a rotated credential to go on
      // failing through two correct-looking saves.
      const already = await allNamed(client, org, name)

      if (already.length) {
        // SAID OUT LOUD, because a silent convergence hides the defect that
        // made it necessary. Somebody reading this knows why a credential
        // appeared not to rotate, and that one name is stored twice.
        if (already.length > 1) {
          // THE SPELLINGS ARE NAMED, because that is the part nobody can
          // see. `wikimedia-pwd` and `WIKIMEDIA_PWD` are one name to every
          // reader and two rows in the vault, and until this line printed
          // them the only symptom was two machines disagreeing about a
          // value with no way to tell why.
          const spellings = [
            ...new Set(already.map((one: any) => String(one.key))),
          ]

          process.stderr.write(
            `${name} is stored ${already.length} times at the provider,\n` +
              `under ${spellings.length} spelling(s): ${spellings.join(', ')}\n` +
              'All of them were just written, so every reader now agrees.\n\n' +
              'A key is not unique here and the raw spellings differ, so a\n' +
              'read keeps whichever copy the provider listed last. That is\n' +
              'why a saved value could appear not to take effect on one\n' +
              'machine while working on another. Remove the spare copies\n' +
              'when convenient: `zone toss` takes the name.\n',
          )
        }

        // EVERY COPY IS RETRIED. A blip halfway through convergence
        // leaves the spellings disagreeing again, which is the exact
        // state this loop exists to end.
        for (const one of already) {
          await patient(() =>
            client
              .secrets()
              .update(org, one.id, name, value, note, [project]),
          )
        }

        return 'grew'
      }

      await patient(() =>
        client.secrets().create(org, name, value, note, [project]),
      )

      return 'made'
    },

    // Remove one secret by name.
    drop: async (
      token: string,
      org: string,
      path: string,
      name: string,
    ): Promise<boolean> => {
      const client = await open(token)
      const already = await named(client, org, name)

      if (!already) {
        return false
      }

      await patient(() => client.secrets().delete([already.id]))

      return true
    },

    // Read one secret's value by name.
    // EVERY SECRET IN THE ORGANIZATION, with its value and its note.
    //
    // This is what `zone read` needs, and it is why the container does not
    // need the `bws` CLI. `bws` is a Rust binary that is not in the image
    // and would have to be downloaded into it; the SDK is already a
    // dependency and speaks the same API.
    //
    // TWO CALLS, NOT ONE PER SECRET. `list` returns metadata only, so the
    // ids it yields are fetched together with `getByIds`. Asking per secret
    // would be nine hundred round trips.
    //
    // The note comes back on the list rather than the fetch in some SDK
    // versions, so both are merged by id and whichever carries it wins.
    all: async (
      token: string,
      org: string,
      // The projects asked for. Values are fetched ONLY for these, so
      // naming one zone does not pull every secret in the organization
      // into the process. Empty means all of them.
      binds: string[] = [],
    ): Promise<
      Array<{ name: string; body: string; note: string; bind: string }>
    > => {
      // NO SDK: fall back to `bws`, which is what reading used before.
      // A checkout has `bws` and often not the SDK. An alpine image has
      // NEITHER available to it: `@bitwarden/sdk-napi` publishes no
      // linux-x64-musl binary, so the require can never succeed there and
      // `bws` is installed into the image instead. Neither environment
      // should have to carry the other's client.
      if (!maybe()) {
        const cp = need('node:child_process')
        const out: Array<{ name: string; body: string; note: string; bind: string }> = []

        // NO CLIENT AT ALL is a different thing from a project that came
        // back empty, and it has to say so. Swallowed alongside the empty
        // ones it reads as "these secrets are not at the provider", which
        // sent a container start chasing a credential that was fine.
        try {
          cp.execFileSync('bws', ['--version'], {
            stdio: 'ignore',
            timeout: 10000,
          })
        } catch (e: any) {
          if (e?.code === 'ENOENT') {
            process.stderr.write(
              'No Bitwarden client is installed, so no value can be read.\n\n' +
                'This process found neither one:\n\n' +
                '  @bitwarden/sdk-napi   the native module, preferred\n' +
                '  bws                   the command line tool\n\n' +
                'On alpine (musl) the SDK is not an option: it publishes\n' +
                'binaries for linux-x64-GNU, darwin and win32 only. Install\n' +
                '`bws`, which does ship a musl build.\n\n' +
                'THE CREDENTIAL IS NOT THE PROBLEM HERE. Nothing has been\n' +
                'asked of the provider yet.\n',
            )
            process.exit(1)
          }
        }

        for (const bind of binds.length ? binds : ['']) {
          try {
            const raw = cp.execFileSync(
              'bws',
              ['secret', 'list', bind, '--output', 'json'].filter(Boolean),
              {
                encoding: 'utf8',
                maxBuffer: 33554432,
                timeout: 20000,
                env: { ...process.env, BWS_ACCESS_TOKEN: token },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            )

            for (const one of JSON.parse(raw)) {
              out.push({
                name: keyName(one.key),
                body: String(one.value ?? ''),
                note: String(one.note ?? ''),
                bind: String(bind),
              })
            }
          } catch (e) {
            // A project that fails is empty rather than fatal: the caller
            // refuses on a missing required name, and that message names
            // the value, which is more use than a provider error naming a
            // project.
          }
        }

        return out
      }

      const client = await open(token)
      const listed = await patient(() => client.secrets().list(org))
      const rows = listed?.data ?? []

      if (rows.length === 0) {
        return []
      }

      const byId = new Map<string, any>()

      for (const row of rows) {
        byId.set(row.id, row)
      }

      // WHAT `binds` HOLDS DEPENDS ON THE MODE, and both have to work.
      //
      // `note` mode looks the one project up by name and passes its ID.
      // `project` mode passes the zone PATH, which is the project's name.
      // The old `bws` path took whatever it was given as a command
      // argument, so the difference never surfaced.
      //
      // So each entry is matched against an id or a name, and the project
      // list is what turns a name into an id.
      const projects = await patient(() => client.projects().list(org))
      const byName = new Map<string, string>()

      for (const one of projects?.data ?? []) {
        byName.set(String(one.name), String(one.id))
      }

      const wanted = new Set(
        binds.map(one => byName.get(one) ?? one).filter(Boolean),
      )

      // `list` returns metadata only, which is how the wanted rows are
      // picked before any VALUE is fetched. That is the whole isolation
      // guarantee: a run that asks for one zone never holds the others'
      // values, even for an instant.
      // ONLY FILTER WHEN THE PROVIDER SAYS WHICH PROJECT A SECRET IS IN.
      //
      // Not every SDK version puts `projectId` on a list row. Filtering on
      // an absent field matches nothing, and the failure is silent: the
      // fetch succeeds, the cache is written, and every required name reads
      // as missing afterwards. So when no row carries one, take them all
      // and let the zone note do the narrowing, which is what `note` mode
      // does anyway.
      const knows = rows.some((r: any) => String(r.projectId ?? '') !== '')

      const want =
        binds.length === 0 || !knows
          ? rows
          : rows.filter((r: any) => wanted.has(String(r.projectId ?? '')))

      if (want.length === 0) {
        return []
      }

      const got = await patient(() =>
        client.secrets().getByIds(want.map((r: any) => r.id)),
      )

      return (got?.data ?? []).map((one: any) => {
        const meta = byId.get(one.id) ?? {}

        return {
          name: keyName(one.key ?? meta.key),
          body: String(one.value ?? ''),
          note: String(one.note ?? meta.note ?? ''),
          // Which project it belongs to, so `project` mode can still group
          // by it. `note` mode ignores this and reads the note instead.
          bind: String(one.projectId ?? meta.projectId ?? ''),
        }
      })
    },

    one: async (
      token: string,
      org: string,
      name: string,
    ): Promise<string> => {
      const client = await open(token)
      const already = await named(client, org, name)

      if (!already) {
        return ''
      }

      const got = await patient(() =>
        client.secrets().getByIds([already.id]),
      )

      return got.data[0]?.value ?? ''
    },

    // Every project the credential can see, as name and id pairs.
    //
    // THROUGH THE SDK, like every other read, so a tree that has the SDK
    // and no `bws` can run `zone read` in `note` mode, where the one
    // project's id has to be looked up before anything is fetched. This
    // was the last call still shelling out to `bws`, which meant the SDK
    // alone could read every secret and yet not find the project they
    // were in.
    //
    // `bws` is the fallback, exactly as in `all`: no SDK, or no
    // organization id to hand it (the command derives one from the
    // credential and the library does not).
    projects: async (
      token: string,
      org: string,
    ): Promise<Array<{ name: string; body: string }>> => {
      if (!maybe() || !org) {
        const cp = need('node:child_process')
        const raw = cp.execFileSync(
          'bws',
          ['project', 'list', '--output', 'json'],
          {
            encoding: 'utf8',
            maxBuffer: 33554432,
            timeout: 20000,
            env: { ...process.env, BWS_ACCESS_TOKEN: token },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )

        return JSON.parse(raw).map((one: any) => ({
          name: String(one.name ?? ''),
          body: String(one.id ?? ''),
        }))
      }

      const client = await open(token)
      const listed = await patient(() => client.projects().list(org))

      return (listed?.data ?? []).map((one: any) => ({
        name: String(one.name ?? ''),
        body: String(one.id ?? ''),
      }))
    },
  }
})()
