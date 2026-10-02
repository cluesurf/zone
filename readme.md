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
zone bind      configure this machine: who you are, where secrets live
zone call      run a command with secrets in its environment
zone code      manage this machine's bootstrap credentials
zone load      run a command with a zone's values in its environment
zone list      the names a path resolves to, never their values
zone save      save the declaration to the provider. Never deletes
zone wash      rewrite stored notes into the current shape
zone read      fetch from the provider and fill the local cache
zone move      values, to a platform that keeps its own copy
zone hook      put one value on the clipboard, without printing it
zone scan      what is wrong across the tree. Needs no provider
zone walk      every zone path, one per line, for shell completion
zone deck      which declarations are in force here, and their caches
zone lock      the master key that opens this machine's local cache
zone show      what this machine is bound to
zone test      check the whole setup without revealing anything
zone toss      unbind this machine and remove every stored code
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
pnpm zone:test
```

From the repository root. It builds the package with `term make`, runs
the `.tree` suites under `test/` through `term test`, the TypeScript
suites for sealing, the cache and the provider SDK, and the shell
harnesses for `fresh`, `save`, `load`, `help` and the end-to-end run
against a fake provider, which touches no keychain.

## Running it

`bin/zone` runs the source through the Term CLI in this repository when
one is beside it, and otherwise the built console in `host/line/`, which
runs with `node` alone:

```bash
term boot code/line/base.tree --out host/line
```

Link it once to type `zone` from anywhere:

```bash
ln -s "$PWD/bin/zone" ~/.local/bin/zone
```

## Design

`note/library/zone/readme.md`.

## License

Copyright 2021-2026+ <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe.
