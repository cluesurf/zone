<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<h3 align='center'>@term/zone</h3>
<p align='center'>
  Environment and secrets
</p>

<br/>
<br/>
<br/>

## Installation

```bash
term save @term/zone -g
```

It installs the `zone` command from the Term registry, into
`~/.base/@term/code/call`, which a Term install already puts on the PATH.
It needs Term 2.10 or newer (https://term.surf). `term toss @term/zone -g`
removes it, and `term save @term/zone -g` again updates it.

Zone comes only from the Term registry. The old npm package
`@cluesurf/zone` is not updated any more.

Zone talks to Bitwarden through one pinned release of Bitwarden's `bws`
command line tool, which it fetches once into `~/.base/@term/zone/bws/`
and checks against a sha256 it carries. It never runs a `bws` from the
PATH.

## Overview

`zone` binds a machine, keeps its bootstrap credential in the operating
system's own keystore, and runs a command with secrets that exist only
for the life of that child process.

Nothing lands in a `.env`, a shell profile, git, or the terminal.

```bash
zone load example -- npm run dev
```

## Commands

```text
zone bind      configure this machine and its provider
zone call      run a command with a sort's secrets
zone code      manage this machine's bootstrap credentials
zone load      run a command with a zone's values
zone list      the names a zone resolves to, never values
zone save      write the declaration to the provider
zone wash      rewrite stored notes into the current shape
zone read      fetch values and fill the local cache
zone move      send values to a platform's own store
zone hook      put one value on the clipboard, unprinted
zone scan      what is wrong across the tree, offline
zone walk      every zone path, for shell completion
zone deck      the declarations in force here, and caches
zone lock      the master key of this machine's cache
zone show      what this machine is bound to
zone test      check the setup without revealing anything
zone toss      unbind this machine, remove stored codes
```

`zone <command> --help` describes each one.

## Three kinds of thing

Kept as distinct types on purpose, because collapsing them is how a
bootstrap credential ends up treated like an ordinary variable and
printed.

| | |
| --- | --- |
| `code` | the bootstrap credential that opens a provider |
| `hold` | a value retrieved from that provider |
| `need` | a declared requirement, carrying no value at all |

## Where the credential lives

The bootstrap credential is kept in one of five stores, chosen by what
the machine has. `zone bind` records the choice, and `zone show`
reports it.

| store | where the credential lives |
| --- | --- |
| `keychain` | macOS Keychain, through `security` |
| `secret` | Linux Secret Service, through `secret-tool` |
| `manager` | Windows Credential Manager |
| `env` | the `ZONE_CODE` environment variable |
| `prompt` | nowhere, asked on each run |

The system stores are preferred: encrypted at rest, and unlocked by the
user's own login. **`env` is the headless store.** A CI runner, a
container, or a server has no desktop keychain but does have an
environment, filled from whatever secret store the platform provides.
Set `ZONE_CODE` (or `ZONE_CODE_<TIER>` for one tier) to the bootstrap
token and zone fetches everything else, so the platform holds one secret
instead of a whole `.env`. Force a store with `ZONE_SAVE=env` when
detection would pick the wrong one.

## Where things are on disk

| file | holds | written by |
| --- | --- | --- |
| `~/.base/@term/zone/zone.tree` | the machine binding: who this machine is, its provider, which store holds the credential. No secret | `zone bind` |
| `<project>/zone.tree` | the declaration: the names a project needs, never their values. Safe to commit | you |
| `<project>/.base/@cluesurf/zone/zone.code.tree` | the local cache of fetched values, sealed with the master key | `zone read` |

The machine binding, as `zone bind` writes it:

```tree
zone <1>

mind ada
host ada-laptop
base development

hold bitwarden
  team example

save keychain
```

A declaration, at the root of a project:

```tree
self example

base bitwarden

bind api-region, <us-east>

need api-key
need database-url
want error-report-dsn

zone moon
  need database-url
```

`need` must be present or the command refuses to start. `want` may be
absent. `bind` is plain config, read from the file on every run and
never stored at the provider. A `zone` block inherits every name above
it. Names are kebab-case here and become `SCREAMING_SNAKE_CASE` in the
child's environment.

## What it will not do

- Print a credential. There is no flag for it.
- Mask one. A fragment still identifies the service and often the account.
- Put a credential in a command argument, where process inspection sees it.
- Pretend removing a local copy revoked anything remotely.

## Tests

```bash
bash test/all.sh
```

From this folder, with Term installed (https://term.surf). It first
checks that nothing in the package reaches outside it (`test/alone.mjs`),
then builds the package with the Term release `deck.tree` asks for
(`need @term/code, mark <2.10.x>`), runs the `.tree` suites under `test/`
through `term test`, the TypeScript suites for sealing, the cache, the
provider calls and the pinned `bws` fetch, and the shell harnesses for
`fresh`, `save`, `load`, `help` and the end-to-end run. Every provider call
goes to a fake `bws` (`test/fixture/bin/bws`), reached through a copy of
the package whose pin is the fake's (`test/fake.sh`), so nothing touches a
keychain, the network or Bitwarden. The TypeScript suites run under `tsx`, which must be on PATH.

## Working on zone

The `zone` on the PATH is the installed release. To run a clone's source
instead, call `call/zone` from the clone. It boots the source with the
installed `term`, at the release `deck.tree` asks for, and otherwise runs
the built console in `host/line/`, which runs with `node` alone:

```bash
term boot code/line/base.tree --out host/line
call/zone --version
```

A release is published from a clean clone with `term host`, at an even
patch number.

## License

Copyright 2021-2026+ <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe.
