# Design: the per-visitor Kestrel sandbox

demo.getkestrel.dev lets anyone open the real Kestrel editor, poke at the "Field Notes" sample publication, schedule a send, and read the public archive, without touching anything real and without any email leaving. This document records how, and why it is built this way. It was written against Kestrel v1.2.0; the file and line references below are to that tag.

## Goals and non-goals

Goals:

- A visitor gets the real Kestrel app, not a mock: the same editor, API, render path, send state machine and archive pages that a self-hoster runs.
- Each visitor's changes are private to them and disappear on their own.
- No email can ever leave, whatever a visitor does.
- Keeping the demo current with Kestrel is a one-line version bump plus a redeploy.

Non-goals:

- Persisting anything a visitor makes beyond the idle TTL.
- Letting visitors share what they made. That is a deliberate limitation, not a missing feature (see "The safety property").
- Changing Kestrel for self-hosters. Kestrel gains nothing for the demo's sake: what the demo needs that Kestrel doesn't have is a small patch in this repo (see "The patch set").

## Why a separate repo

getkestrel.dev is a static Hugo site that owns no data. Adding a stateful Worker with Durable Objects, R2 and per-visitor storage to it would muddle its deploy, its CI and its purpose. Kestrel itself should stay small and legible for self-hosters, who have no use for sandbox infrastructure. So the demo lives here, as a thin wrapper around a pinned Kestrel release. What the wrapper needs Kestrel to do differently is a small patch set in this repo, applied to the pinned release at build time, so Kestrel ships nothing that only the demo uses. The demo's own deploy creates the `demo.getkestrel.dev` DNS record (a Workers Custom Domain, README.md "Deploy"). The website-side work (the "Try the live demo" CTA, the hero frame linking here) stays in kurtbruns/getkestrel.dev#16.

## Architecture

```
browser ──► demo Worker (this repo)
              │  static assets: Kestrel's built /dashboard tree (identical for everyone)
              │  everything else:
              │    session cookie ──► Durable Object id (one DO per visitor)
              ▼
            SandboxDO
              ├─ env.DB    = D1-compatible adapter over the DO's own SQLite
              ├─ env.MEDIA = R2 wrapper scoped to this session's prefix (seed images shared, read-only)
              ├─ env.*     = fixed demo vars (PROVIDER=fake, APP_ORIGIN=https://demo.getkestrel.dev, ...)
              ├─ fetch()   → kestrel.default.fetch(request, sandboxEnv, ctx)
              └─ alarm()   → kestrel.default.scheduled(controller, sandboxEnv, ctx), plus idle-TTL cleanup
```

The wrapper doesn't fork Kestrel's repo. It builds a pinned Kestrel release plus a small patch set (see "The patch set"), imports that build's own default export (`src/index.ts`, an `ExportedHandler` with `fetch(request, env, ctx)` and `scheduled(controller, env, ctx)`), and calls it with a sandboxed `env`. Kestrel reads every binding off `env` per request (`routerFor(env)` builds and caches the router from `getConfig(env)`; every `db/` function takes `env.DB` as an argument), so swapping the bindings is enough to swap the world it runs in.

### Request flow

1. A request arrives at the demo Worker. Requests for Kestrel's static assets (`/dashboard/` and its CSS/JS, the favicon) are served from the Workers assets directory before the Worker runs. They are the same bytes for every visitor and carry no data. An asset path that reaches the Worker anyway (a file that doesn't exist) gets a plain 404 and never a session, as do `/health` and `robots.txt`.
2. For anything else, the Worker reads the session cookie. With no valid cookie it creates a new session, subject to the per-IP rate limit (see "Lifecycle"), and sets the cookie on the response. Crawlers are kept away by `robots.txt` (`Disallow: /`) and `noindex`, so they don't mint sandboxes.
3. The Worker derives the Durable Object id from the session and forwards the request to that DO.
4. On its first request after it starts, the DO applies any of Kestrel's `migrations/` it hasn't yet and seeds Field Notes if its database isn't seeded for this Kestrel version, all inside `blockConcurrencyWhile`, so concurrent first requests seed once and none sees a half-seeded database. Then it calls Kestrel's `fetch` with the sandboxed env and returns the response. The Worker makes it private and adds `X-Robots-Tag: noindex`, as it does for every response it sends, including its own errors.

### Session identity

The cookie (`__Host-kestrel_demo`) carries a random 256-bit session token and an HMAC of it, signed with the Worker secret `SESSION_SECRET` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days). The `__Host-` prefix means a browser takes it only from this exact host, so another getkestrel.dev subdomain can't plant one. The Worker honors only tokens it signed, in their canonical encoding, and tries every cookie of that name, so a junk one sent beside the real one can't knock a visitor out of their sandbox. A forged or tampered cookie counts as no cookie. The DO is named by a second, domain-separated HMAC of the token (`"kestrel-demo sandbox v1:" + token`, where the cookie's signature uses `"kestrel-demo session v1:"`). So the only way to reach a sandbox is to hold its cookie, and a token can't be derived from a DO id, a URL, or anything Kestrel emits. Nothing in a URL ever selects a sandbox (`src/session.ts`).

Only a GET starts a session. The editor's first requests are GETs, while a cookieless write is another site's form posting here (a `SameSite=Lax` cookie isn't sent on a cross-site POST), and starting a session for it would replace the visitor's own. A cookieless POST, PUT, DELETE, HEAD or OPTIONS gets a 403 with no cookie and no sandbox. Two tabs opened at the same instant, before either has a cookie, get two sandboxes; the last cookie wins, and the other tab finds its sandbox gone on its next request. That's acceptable for a demo.

Every sandbox response is private. Kestrel marks its public pages and media `public`, but in the demo every page is one visitor's own and the same URL names different content in different sandboxes. So the Worker rewrites `public` to `private` (and sets `private` where Kestrel sets nothing, as on its errors, and makes HTML `private, no-cache`, so a page always revalidates after an edit, a reset or the idle wipe), adds `Vary: Cookie`, and sends `private, no-store` on a response that starts a session, since it carries the cookie. If a sandbox can't start (its migrate or seed throws), the Worker logs `demo.sandbox_failed` and answers a 503 asking the visitor to reload. It still hands over a new session's cookie, so the reload retries the same sandbox rather than starting another.

## The safety property

**A visitor can only ever see their own sandbox.** Every request, including the public `/archive/*` pages, the landing page at `/`, and `/media/*`, is answered by the visitor's own Durable Object, chosen by their cookie and nothing else. So nobody can mint a demo.getkestrel.dev URL that shows anyone else their content. If someone writes an offensive post, publishes it, and shares the archive link, everyone who opens that link sees the pristine Field Notes sandbox their own cookie leads to (a fresh one, if they have none), and the post's slug simply 404s. The demo can't be used to host or distribute content.

This is the main reason for the per-visitor design over a single shared demo instance. Supporting measures:

- Every demo response carries `X-Robots-Tag: noindex`: the Worker sets it on everything it answers, and `patches/0003-demo-noindex.patch` adds it to the static editor through Kestrel's `_headers`. `robots.txt` disallows everything, so no sandbox's content is indexed.
- No shared cache can keep one sandbox's response for another: every sandbox response is `private` with `Vary: Cookie`, and one that starts a session is `no-store` ("Session identity").
- Mail can't leave: `PROVIDER=fake` is fixed in the sandbox env, no `NOTIFY` binding is declared, and outbound `fetch` is refused inside the DO (see "Sends").
- Visitor uploads are capped and scoped to the session's R2 prefix, and are served only through the session's own DO.
- Sharing a cookie shares a sandbox. That is the visitor's own choice with their own browser state, not a link anyone can be handed.

The tests that enforce it:

- `test/isolation.spec.ts`, named for the property:
  - a post A publishes is on A's public archive, and 404s at the same URL for B;
  - it's absent from B's archive index, landing page and post list;
  - it 404s for a visitor with no cookie (who gets a fresh sandbox);
  - it 404s for a cookie that only resembles A's;
  - every response class the Worker makes carries `noindex`, the 429 page included.
- `test/build/assets-headers.test.mjs`: the built static assets' `_headers` marks every asset `noindex`.
- `test/media.spec.ts`:
  - an upload in A 404s in B at the same path;
  - a replaced or removed logo stays in its own sandbox;
  - media is served privately;
  - keys can't escape a sandbox's prefix.
- `test/sessions.spec.ts`:
  - the same cookie reaches the same sandbox, and only its own;
  - forged, tampered and junk cookies are new sessions, not a way in;
  - a cookieless write starts no session;
  - sandbox responses are private.
- `test/sends.spec.ts`: a full send completes with no network egress, and any `fetch` in a sandbox is refused.

## Kestrel integration

### Version pin

`.kestrel-version` holds the Kestrel release tag the demo runs (starting at `v1.2.0`), mirroring getkestrel.dev's `.kestrel-docs-version`. The build makes a shallow clone of Kestrel at exactly that tag into a gitignored `vendor/kestrel/`, applies the patch set, runs Kestrel's own `npm ci`, and builds:

- the Worker code, which the wrapper imports from Kestrel's `src/`;
- Kestrel's admin client (`scripts/build-client.mjs`: `public/` + `client/` → `dist/public`), which the demo serves as its static assets;
- the build stamp (`scripts/stamp-version.mjs` → the gitignored `src/generated/version.ts`), without which Kestrel's `src/build.ts` fails to import.

The demo's wrangler config has to carry what Kestrel's does for its code to bundle: the `Text` rule for `**/*.md` (the demo posts and the setup docs are imported as text) and `nodejs_compat`. The css-inline `.wasm` import needs no rule, since wrangler's default `CompiledWasm` rule covers it, as it does in Kestrel's own config.

A clone rather than a git dependency (`github:kurtbruns/kestrel#v1.2.0`), because npm installs a git dependency without its devDependencies (Kestrel's client build needs esbuild) and without `.git` (so the build stamp would read `dev` instead of the tag), and because a patch set needs a working tree to apply to. It mirrors how getkestrel.dev's CI clones Kestrel at `.kestrel-docs-version`.

### The `kestrel` module

The wrapper reaches Kestrel's code through one module specifier, `kestrel`. For bundling, wrangler (`alias` in `wrangler.jsonc`) and Vitest (`resolve.alias`) resolve it to `kestrel/entry.ts`, which re-exports from the patched tree: the default export, `getConfig`, `seedDatabase`, the build stamp, and the demo-image index the build writes to `vendor/demo-assets.ts`. For type-checking, `tsconfig.json` `paths` resolves it to `src/types/kestrel.d.ts` instead, a hand-written declaration of just that slice. This repo's `tsc` therefore never type-checks Kestrel's source, which would drag in Kestrel's own generated global `Env` and ambient `*.md` declarations. Kestrel's own typecheck, run on the patched tree, covers Kestrel. The two files must stay in step, and the Worker tests catch a mismatch at runtime.

### The patch set

`patches/` holds a few small `git` patches against the pinned tag. The build applies them in filename order right after cloning (`git apply`), before anything is built. A patch that doesn't apply cleanly stops the build, so a Kestrel release that changes the patched lines fails loudly in the PR that bumps `.kestrel-version`, never quietly in production. CI applies them on every PR.

Rules for a patch:

- One concern per patch, named for it (`0001-demo-auth.patch`), with a header comment that says what it changes, why the demo needs it, and which issue added it.
- As small as the concern allows. A patch changes behavior only where the demo needs it to, and touches no invariant from Kestrel's `docs/SPEC.md` (the send state machine, the single render path, the consent rules).
- If a fix is one self-hosters would want too, it goes upstream as a Kestrel issue instead, and the patch is dropped once a release carries it.

Planned patches:

| Patch | What it changes | Issue |
| --- | --- | --- |
| `0001-demo-auth` | `authenticate` (`src/auth/middleware.ts`) returns a demo principal for every request; `whoami` and the settings reflection report the auth mode as `demo`, and the client's types, curl snippet (no credential headers) and settings label accept it | #2 |
| `0002-fake-outbox-bound` | keeps only the newest 500 messages in the fake transport's and the fake notifier's in-memory outboxes, and the newest 5,000 keys in the fake transport's idempotency map (dedup is best-effort: the window is shared by every sandbox in an isolate, and a missed dedup only adds a duplicate row to the fake outbox, never a second delivery record) | #6 |
| `0003-demo-noindex` | adds a rule giving every static asset `X-Robots-Tag: noindex` to Kestrel's `public/_headers` (static assets are served before the Worker runs, so their headers come only from that file) | #7 |
| `0004-demo-chrome` | in demo auth mode, the editor's "Demo sandbox" chip and a sandbox strip linking to the reset (with `--demo-h` for the layout); on every public page, a matching strip with "Open the editor" and "Reset demo"; a client spec for the editor side | #9 |

Why a patch set, over the two alternatives considered:

- **A seam in Kestrel** (an exported `createHandler({ authenticate })`, briefly filed as kurtbruns/kestrel#471 and closed): general and tested upstream, but it would make Kestrel ship, document and maintain an extension point whose only consumer is this demo, which cuts against keeping Kestrel small for self-hosters.
- **A full fork** (a `kestrel-demo` repo or long-lived branch): no build-time machinery, but every release becomes a merge in a second repo with its own history and CI, which is a lot of process for a few dozen changed lines.

On the patched tree, Kestrel's own client specs, typecheck and CSS token check pass. Its server specs that assert what the patches change on purpose fail there: the auth specs under `0001`, and the dev-badge specs in `test/archive.spec.ts` under `0004`. Everything else passes, including its send, notification and fake-transport specs.

The cost of patches is that they touch Kestrel's internals, so a refactor upstream can break them; they fail at build, which is the right place. The demo is then "Kestrel at the pinned tag plus these patches", and the patch list is short enough to read in full.

### Updating the demo

When Kestrel cuts a release: bump `.kestrel-version`, rebuild (which re-applies the patch set; fix or drop any patch that no longer applies, or that the release made unnecessary), run the demo's checks (the D1 adapter suite against the new migrations, the isolation tests, a seed smoke test), and redeploy. Existing sandboxes were migrated at the old version. The DO records the migrations it applied (`demo_migrations`) and the Kestrel version that seeded it (the seed marker in `demo_meta`), and a sandbox from an older version is reset on its next request rather than migrated in place: sandboxes are disposable, and a reset is always correct. The procedure lives in a skill or a documented script, like getkestrel.dev's `refresh-from-kestrel`.

### The D1-compatible adapter

`env.DB` is an object that implements the slice of the D1 API Kestrel uses, over the DO's synchronous `ctx.storage.sql`. Surveyed at v1.2.0:

- `prepare(sql)` (about 143 call sites), `bind(...values)`, `first()` and `first(column)`, `all()`, `run()`, and `batch(statements)` (23 sites, in `db/notifications`, `db/subscribers`, `db/sends`, `db/posts`, `db/seed`, `send/schedule`, `send/remake`, `send/budget`).
- `raw()` and `exec()` appear only as pass-throughs in `send/budget.ts`'s metering wrapper. No call site uses them directly, and nothing uses `dump()` or `withSession()`. The adapter still implements `raw()` and `exec()` so the metering wrapper stays type-correct.
- Results: `all()` and `run()` return `{ results, success, meta }`. Kestrel reads `meta.changes` (16 sites), so it must be exact. DO SQLite's cursor reports `rowsWritten`, which also counts index writes, so the adapter reads SQLite's own `changes()` (and `last_insert_rowid()`) after each statement and uses `rowsWritten` only to tell whether the statement wrote at all, which a SELECT following a write needs.
- `batch` must be atomic: all statements commit or none do, which the adapter gets from `ctx.storage.transactionSync`. Kestrel also uses `batch` as a consistent multi-SELECT read (the send list and feed read a sequence number, counts and rows together), so every entry returns its full rows, all read inside that one transaction.
- Error text matters: `send/schedule.ts` recognizes a double schedule by matching `UNIQUE constraint failed: sends.post_id` in the error message, so the adapter must let SQLite's constraint messages through unchanged.
- Schema features: every table is `STRICT`, queries use `json_each` to bind lists, some use `RETURNING`, and foreign keys are enforced, as on D1. DO SQLite supports all four, and `test/d1-adapter.spec.ts` proves it on Kestrel's own schema, ending with Kestrel's full Field Notes seed run through the adapter.
- Held to D1's limits: at most 100 bound parameters, `undefined` refused as a bind value, and `first(column)` refusing an unknown column, so the demo is no more lenient than a real deployment.
- Migrations: `src/d1/migrate.ts` applies Kestrel's `migrations/*.sql` in name order, each inside `transactionSync` (DO SQLite refuses `BEGIN`/`COMMIT` in `sql.exec`), and records each in its own `demo_migrations` table, so a re-run is a no-op. DO SQLite's `sql.exec` refuses a script whose tail after the last `;` is only a comment (after running what came before it), where wrangler's runner accepts one, so every script gets a trailing no-op statement. The SQL comes from the same generated module as the demo images, `vendor/demo-assets.ts`, so a Kestrel release with a new migration needs no change here.

### Seeding

The seed is Kestrel's own: `seedDatabase(env, config, images, logo)` in `src/dev/seed.ts`, the function behind `POST /api/dev/seed`. Its posts and publication file are imported as text from `demo/`, and its images are passed in as files. The build gathers every image beside a post's `index.md` (named `<bundle>/<file>`) and the logo `publication.md` names into the generated `vendor/demo-assets.ts`. That's a superset of what Kestrel's `scripts/seed.mjs` uploads, which is harmless because the seed looks each image up by the name its post uses. The Worker bundles that module, with the images as `ArrayBuffer`s through wrangler's `Data` rule, so a release that adds or renames a demo image needs no change here. The wrapper calls it directly inside the DO rather than through the dev route, which a deployed config never registers. The seed writes post images and the logo to `env.MEDIA` under deterministic keys, which is what lets the media wrapper share one read-only copy (see "Media").

### Auth

The original plan was to run the sandbox in Kestrel's `dev` auth mode. That doesn't work, by design. `getConfig` (`src/env.ts`) only resolves `devAuthSecret` in a "dev-shaped" env: fake provider, no Access team domain, **and a loopback `APP_ORIGIN`** (`localhost` or `127.0.0.1`). With `APP_ORIGIN=https://demo.getkestrel.dev`, `devMode` is false, so the `/api/dev/*` routes (including `/api/dev/token`, the editor's token bootstrap in `client/main.ts`) are not registered, bearer tokens are ignored, and every admin route answers 401. The `src/app.ts` line that reports `auth.mode` as `dev` whenever Access is unconfigured is only the `whoami` label; the gate itself is closed.

The demo-auth patch opens it for the sandbox only: `authenticate` in `src/auth/middleware.ts` returns a human principal (e.g. `demo@getkestrel.dev`) for every request, and `GET /api/whoami` reports `auth.mode: "demo"`. That is correct here, and only here, because a request reaches a sandbox's Kestrel only through its owner's cookie (see "The safety property"): whoever holds the cookie is that sandbox's publisher. Everything else in Kestrel's gate stays as shipped: `devMode` is still false, so the `/api/dev/*` routes stay absent; admin writes still refuse cross-site requests; admin responses are still `no-store`. The client boots unchanged: with no token it tries `/api/dev/token`, gets a 404, and the `whoami` probe then succeeds without a header.

Rejected along the way: a loopback-origin shim (`APP_ORIGIN=http://localhost` with `ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE` pointed at the real host and a per-sandbox `DEV_AUTH_SECRET`), which works against v1.2.0 unpatched but impersonates the very predicate Kestrel uses to fence local dev, and re-exposes the dev routes the wrapper would then have to block.

### Static assets and demo chrome

Kestrel serves `/dashboard/` from Workers static assets (`assets.directory: ./dist/public`, `not_found_handling: none`), which bypass the Worker. The demo serves the same built tree the same way. Since the shell is identical for every visitor, serving it from assets doesn't weaken the safety property. The demo chrome is `patches/0004-demo-chrome.patch`, so it lives in Kestrel's own markup and CSS tokens rather than being injected from outside:

- **The editor:** when `whoami` reports `auth.mode === "demo"`, the identity chip reads "Demo sandbox" with no sign-out link. A strip above the whole workspace, rendered once and outside the routed view, says the sandbox is private and temporary, and links to "Reset demo" and to getkestrel.dev. Its height is published as `--demo-h`, which the full-height layout and the sticky sidebar subtract, so the sidebar's foot stays on screen. On a phone the strip clears the fixed menu button.
- **Every public page:** card pages, the reader shell and a hosted post page get a matching strip pinned to the bottom, with "Open the editor" and "Reset demo". It rides the injection points of Kestrel's dev-only dashboard badge (`devDashboardStyle` and `devDashboardBadge` in `src/lib/page.ts`), which reach only pages as served, never a frozen render or a sent email (I3). In this build those helpers always emit the strip, since only the demo builds the patch. On a phone the strip is compact, and the page is padded clear of it.
- **Reset is a link everywhere,** to a confirmation page the sandbox serves at `GET /_demo/reset` under its own policy (`form-action 'self'`, no script). Its button posts the reset. A form on Kestrel's pages couldn't do this: a post page forbids form posts (`form-action 'none'`, so a form in a post's body can't act on the admin API), and every public page forbids script, so neither could confirm a reset itself.
- **SPEC §11** says no public page links into the Access-gated admin, with the dev-only shortcut as its one exception. The strip's "Open the editor" link departs from that on purpose: the demo's editor has no Access wall, and each visitor's editor is their own sandbox, so the rule's reason doesn't hold. No I-invariant is touched.

## Media

`env.MEDIA` is `SandboxMedia` (`src/media.ts`), a wrapper with the slice of the R2 binding's shape Kestrel uses: `get`, `put` (with `httpMetadata`) and `delete`. It also has `head` and `list` for the demo's own use.

- **Scoped keys.** Every key is rewritten to `sessions/<sandbox DO id>/<key>`, so a sandbox can only address its own objects. A key with an empty, `.` or `..` segment, or a leading `/`, is refused with Kestrel's own `HttpError`: a 404 for a read (Kestrel's router decodes `/media/:key`, so `..%2F` arrives as `../`) and a 400 for a write, never a 500. `list` returns only the sandbox's own objects, with the prefix stripped.
- **Shared seed images.** Kestrel's seed is given a separate view of the sandbox's media (`seedView`, in a seed-only env) whose `put` writes a prefix every sandbox shares, `seed/<kestrel tag>/`, once (skipped if the object is already there), so seeding a new sandbox writes no image bytes. Only the seed ever holds that view: the bucket Kestrel's request handlers see can never write the shared prefix. A sandbox's read of a key it doesn't hold falls back to that prefix. A re-seed first clears the sandbox's own uploads (which Kestrel's `resetAll` can't reach), and the seed view drops anything that would shadow a seed key, so a re-seed restores the seed's images. Old tags' `seed/` prefixes are left in place; they're small, and nothing may delete the current tag's.
- **Tombstones.** Deleting a key records a tombstone in the sandbox's SQLite, so a deleted seed image (a removed logo, a deleted post's cover) stays deleted for that sandbox rather than falling back to the shared copy. Only a write that lands clears it: a refused or failed upload leaves the key deleted.
- **Caps.** Uploads are capped at 2 MB per object (which binds post images; Kestrel's own caps are 5 MB for those and 512 KB for the logo) and 20 MB per sandbox, with the byte count kept in the sandbox's SQLite. The size is checked and reserved with no await in between, before the bytes go to R2, so parallel uploads (a DO serves other requests while it awaits R2) can't pass the cap together. A failed write gives the reservation back. Over a cap, `put` throws Kestrel's own `HttpError(413, "upload_too_large")`, which Kestrel's router answers as a 413 with its usual error body, and nothing is written. The DO also refuses an upload request that declares more than the per-object cap plus a multipart allowance (413), or no `Content-Length` at all (411), before Kestrel reads the body.
- **No shared caching.** Seeded post ids are the same in every sandbox, so one `/media/...` URL names different bytes in different sandboxes. The Worker makes every sandbox response private ("Session identity"), so Kestrel's `public, max-age=3600` on media becomes `private, max-age=3600` with `Vary: Cookie`, and no shared cache keeps one visitor's copy for another.
- **Cleanup.** `clear()` deletes everything under the sandbox's prefix and its records, for the idle-TTL cleanup and reset (#8). The shared seed prefix is never deleted by a sandbox.

## Sends

- **The fake transport only.** `sandboxEnv` fixes `PROVIDER=fake` and declares no `NOTIFY` binding, so publisher notifications go through the fake provider too (`notifyChannel` resolves to `provider` deployed, `fake` on a loopback dev origin). As a second check, the DO resolves Kestrel's own config before migrating and refuses to run unless the provider is `fake` and notifications aren't Cloudflare's email (`checkSandboxConfig`).
- **The alarm drives the sweep.** The DO's alarm calls Kestrel's own `scheduled()` with a `ScheduledController`-shaped `{ cron: "* * * * *", scheduledTime, noRetry }`, collects its `waitUntil` work, and awaits it. A tick that fails is logged, as Kestrel's own cron would, and the next one comes from re-arming, not the runtime's alarm retries. After every request and every sweep, the DO re-arms the alarm for `nextWake`, the earliest reason to wake: a minute from now while a send is `sending`, and the earliest scheduled send's `fire_at`. The idle expiry ("Lifecycle") is a third term. Every reason to wake is a term in `nextWake`, so the one alarm always serves the soonest, and a seeded sandbox with nothing to send wakes only at its expiry. There is no Cron Trigger, so no single tick sweeps every sandbox. The DO reads Kestrel's `sends` table directly (read-only) to decide this, so a Kestrel release that changes those columns fails here loudly. With the plain fake transport, a send is `sending` for at most one tick (or one five-minute lease after a crash), and nothing halts or waits on receipts.
- **Fast enough to watch.** `MIN_LEAD_SECONDS=60` (Kestrel's floor) keeps a demo send watchable within a visit. `SUBREQUEST_BUDGET=1000` (Kestrel's cap) lets a send finish in one tick, since the adapter's statements are local SQLite calls, not D1 subrequests.
- **No egress.** `src/egress.ts` replaces `globalThis.fetch` with one that refuses every request. It's installed by the Worker entry's first import (`src/egress-install.ts`), and ES modules evaluate in import order, so the block is in place before any of Kestrel's modules are even evaluated. Every outbound call Kestrel can make goes through it: Resend's API, SES through aws4fetch, SNS signing certificates and subscription URLs, Access's JWKS. Each resolves the global `fetch` when it's called. In the sandbox none of those paths is even reachable, since the webhook routes delegate to the active provider, always the fake. So the block is a backstop, and the tests show a full send completing with nothing refused, and a refused fetch counted. It's isolate-wide, which is fine: the Worker reaches its sandboxes and R2 through bindings, never the global fetch.

### Module-level state in Kestrel

DOs of one class can share an isolate, so anything Kestrel keeps at module scope is shared across the sandboxes in that isolate, not per sandbox. At v1.2.0 that is:

- `providers/fake.ts`: the in-memory `outbox` of every message "sent" and the idempotency `sentKeys` map. Both grow without bound in a long-lived isolate.
- `notify/fake.ts`: the notifications outbox, which grows the same way.
- `providers/simulate.ts`: the simulation's maps (inert here, since the simulation only engages when dev-shaped).
- `index.ts`'s router cache and `auth/access.ts`'s JWKS cache, which hold config, not visitor data.

None of this is reachable over HTTP outside dev mode (the outbox is read only by `/api/dev/outbox`), so it is not a cross-sandbox read, but the outboxes are an unbounded memory leak. The fake transport's idempotency map also ignores which sandbox a key came from, though keys embed per-sandbox send ids, so they can't collide. The `0002-fake-outbox-bound` patch caps the two outboxes and the idempotency map at a fixed size, keeping the newest entries. (Briefly filed upstream as kurtbruns/kestrel#470 and closed: only the demo runs the fake transport in a long-lived production isolate.)

## Lifecycle

- **Idle TTL.** Each request records `last_seen` in the sandbox's `demo_meta`, before it runs (so an expiry alarm delivered while it awaits I/O sees a visitor) and again after. The value is rewritten at most once a minute. The idle expiry, `last_seen` plus 24 hours (`IDLE_TTL_MS`), is a term in `nextWake`. When the alarm fires past it, the DO wipes itself: its uploads under its R2 prefix (never the shared seed images), its whole SQLite database (`deleteAll`), and its alarm. A request with the same cookie afterwards gets a fresh, freshly seeded sandbox. A wipe that fails is logged and retried five minutes later by the alarm itself, so a sandbox never outlives the runtime's own few retries. An alarm never seeds: one that finds a sandbox wiped or never used clears itself, and one that finds it seeded by another Kestrel release wipes it.
- **Reset.** Every "Reset demo" link (#9's chrome) leads to `GET /_demo/reset`, a confirmation page the sandbox serves itself. Its button posts to the same path, a wrapper route outside Kestrel's paths. The POST is refused unless it comes from the demo's own pages: a browser's `Sec-Fetch-Site` must be `same-origin`, or lacking that, its `Origin` must match. A reset costs as much as a new sandbox, so the Worker counts it against the same per-network limit as new sessions. A reset with no session (an expired cookie) is sent back to the editor, which starts one. The reset wipes the sandbox as the idle TTL does, migrates and seeds it again, and answers a 303 to `/dashboard/`.
- **A new Kestrel release.** On its first start after a deploy, a sandbox seeded by another Kestrel release (its `seeded_kestrel` marker) is wiped and seeded fresh rather than migrated in place ("Updating the demo").
- **Rate limit.** Creating a session costs a migrate, a seed of several hundred statements, and some storage, so new sessions are rate-limited per network with the Workers Rate Limiting binding `NEW_SESSIONS`: 10 a minute per IPv4 address (`cf-connecting-ip`), or per IPv6 /64, since one IPv6 client usually holds a whole /64 and could rotate through it. Past the limit, the visitor gets a short 429 page asking them to wait a minute, with no cookie and no sandbox. A returning visitor's cookie skips the limit. Requests that don't need a sandbox (static assets, `/favicon.ico`, `robots.txt`, `/health`) never create one.

## Configuration of the sandbox env

| Binding / var | Value | Why |
| --- | --- | --- |
| `DB` | D1 adapter over the DO's SQLite | per-visitor database |
| `MEDIA` | scoped R2 wrapper | per-visitor media, shared seed images |
| `PROVIDER` | `fake` | mail never leaves |
| `APP_ORIGIN` | `https://demo.getkestrel.dev` | links, archive URLs, media URLs |
| `ARCHIVE_BASE_PATH` | `/archive` | Kestrel default |
| `SENDING_DOMAIN`, `FROM_ADDRESS`, `AWS_REGION` | `send.field-notes.example`, `Field Notes <newsletter@send.field-notes.example>`, `us-east-1` | required by `Env`, unused by the fake; `.example` can't route mail |
| `MIN_LEAD_SECONDS` | `60` | a send fires within a visit |
| `SUBREQUEST_BUDGET` | up to `1000` | sends finish in one tick |
| `ACCESS_*`, `DEV_AUTH_SECRET`, `NOTIFY`, provider credentials | unset | see "Auth" and "Sends" |

## Open questions

- **Landing.** Should `/` stay Kestrel's public landing page (the visitor's own sandbox), or redirect first-time visitors to `/dashboard/`? Kestrel's rule that no public page links into an admin path is about Access-gated deploys, but the demo banner can offer the way in either way.
- **TTL and storage cost.** 24h idle is a guess. Measure the per-sandbox SQLite size after seed and pick the TTL and the rate limit together.
