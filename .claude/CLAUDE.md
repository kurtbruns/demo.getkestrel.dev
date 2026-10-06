# CLAUDE.md

This repo is the live demo of Kestrel at demo.getkestrel.dev: a thin Cloudflare Worker that runs a pinned Kestrel release inside one Durable Object per visitor. Read `DESIGN.md` before changing anything. It holds the architecture, the safety property, and the open questions.

## Related repos

- **Kestrel** (github.com/kurtbruns/kestrel) is the app being demoed. The build clones it at the tag in `.kestrel-version` into the gitignored `vendor/kestrel/` and applies the patches in `patches/`. Never edit `vendor/` by hand; change a patch instead. If there's a local checkout at `~/Git/kestrel`, it may be on another branch: read it with `git show <tag>:<path>` and `git grep <pattern> <tag>`, and never switch its branch.
- **getkestrel.dev** (github.com/kurtbruns/getkestrel.dev) is the static marketing site. Its issue #16 tracks the demo from the website side (the DNS route, the "Try the live demo" CTA). Don't add demo infrastructure there.

## Patches

What the demo needs Kestrel to do differently is a patch in `patches/`, not a Kestrel change, so Kestrel ships nothing only the demo uses. `DESIGN.md` ("The patch set") lists them and says why.

- One concern per patch, named for it (`0002-fake-outbox-bound.patch`), with a header comment saying what it changes, why the demo needs it, and which issue added it. Keep it as small as the concern allows, and never touch an invariant in Kestrel's `docs/SPEC.md`.
- Make or revise a patch with the recipe in `patches/README.md` (`--apply-only`, commit inside the clone, edit, `git diff`), then re-run the build from clean (`--force`) to prove the set applies. A patch that fails to apply stops the build. That's intended: fix the patch in the same PR that bumped `.kestrel-version`.
- If a fix is one self-hosters would want too, propose it as a kestrel-repo issue instead and drop the patch once a release carries it.

## The safety property

A visitor can only ever see their own sandbox. Every request, public archive pages included, is answered by the Durable Object their session cookie selects, and nothing in a URL selects a sandbox. Never add a route, cache, or shared path that serves one sandbox's data to another session, and never let mail or any other outbound request leave a sandbox. A change that touches routing, sessions, media, or sends keeps the isolation tests passing and adds to them.

## Workflow

- **One issue per pull request.** Work an issue on its own branch and open a **draft** PR that says `Closes #N`. Respect the issue's "Depends on" line: don't start an issue whose dependencies haven't merged.
- **Squash-merge** pull requests, with the PR's title and description as the commit message.
- When the user asks you to change what an issue asks for, rewrite the issue body rather than adding a comment, since whoever picks it up often reads only the body.

## Writing

- **Prose is unwrapped:** one physical line per paragraph in Markdown files, issue bodies, and PR descriptions. Never hard-wrap prose at a column. Lists, tables, and code blocks keep their own line structure.
- Keep `DESIGN.md` current. A change that alters the architecture, the safety property, or an open question updates it in the same PR.
