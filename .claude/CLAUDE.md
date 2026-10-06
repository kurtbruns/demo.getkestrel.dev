# CLAUDE.md

This repo is the live demo of Kestrel at demo.getkestrel.dev: a thin Cloudflare Worker that runs a pinned Kestrel release inside one Durable Object per visitor. Read `DESIGN.md` before changing anything. It holds the architecture, the safety property, and the open questions.

## Related repos

- **Kestrel** (github.com/kurtbruns/kestrel) is the app being demoed. The demo imports it at the tag in `.kestrel-version` and never forks it. When the demo needs something from Kestrel, file a small, general issue in the kestrel repo and link it from the issue here, rather than patching around Kestrel in this repo. If there's a local checkout at `~/Git/kestrel`, it may be on another branch: read it with `git show <tag>:<path>` and `git grep <pattern> <tag>`, and never switch its branch.
- **getkestrel.dev** (github.com/kurtbruns/getkestrel.dev) is the static marketing site. Its issue #16 tracks the demo from the website side (the DNS route, the "Try the live demo" CTA). Don't add demo infrastructure there.

## The safety property

A visitor can only ever see their own sandbox. Every request, public archive pages included, is answered by the Durable Object their session cookie selects, and nothing in a URL selects a sandbox. Never add a route, cache, or shared path that serves one sandbox's data to another session, and never let mail or any other outbound request leave a sandbox. A change that touches routing, sessions, media, or sends keeps the isolation tests passing and adds to them.

## Workflow

- **One issue per pull request.** Work an issue on its own branch and open a **draft** PR that says `Closes #N`. Respect the issue's "Depends on" line: don't start an issue whose dependencies haven't merged.
- **Squash-merge** pull requests, with the PR's title and description as the commit message.
- When the user asks you to change what an issue asks for, rewrite the issue body rather than adding a comment, since whoever picks it up often reads only the body.

## Writing

- **Prose is unwrapped:** one physical line per paragraph in Markdown files, issue bodies, and PR descriptions. Never hard-wrap prose at a column. Lists, tables, and code blocks keep their own line structure.
- Keep `DESIGN.md` current. A change that alters the architecture, the safety property, or an open question updates it in the same PR.
