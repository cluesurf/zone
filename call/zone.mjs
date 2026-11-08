#!/usr/bin/env node
// The `zone` command over the prebuilt console in `host/line`, written by
// `term boot code/line/base.tree --out host/line`, with Node alone: no Term
// CLI and no compile. An install is `term save @term/zone -g`, and a checkout
// uses `call/zone`, which boots the source so an edit is what runs.
//
// JavaScript and not a shell script, because the API container is alpine
// and has no bash.
await import('../host/line/run.mjs')
