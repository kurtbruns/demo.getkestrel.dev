# Design: the per-visitor Kestrel sandbox

demo.getkestrel.dev lets anyone open the real Kestrel editor, poke at the "Field Notes" sample publication, schedule a send, and read the public archive, without touching anything real and without any email leaving. This document records how, and why it is built this way. It was written against Kestrel v1.2.0 and last checked against v1.17.0; the file references below hold at that tag.

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

**A visitor can only ever see their own sandbox.** Every request, including the public `/archive/*` pages, the landing page at `/`, an email's unlisted link at `/email/<token>` (since v1.12.0), and `/media/*`, is answered by the visitor's own Durable Object, chosen by their cookie and nothing else. So nobody can mint a demo.getkestrel.dev URL that shows anyone else their content. If someone writes an offensive post, publishes it, and shares the archive link, everyone who opens that link sees the pristine Field Notes sandbox their own cookie leads to (a fresh one, if they have none), and the post's slug simply 404s. The demo can't be used to host or distribute content.

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
  - a list A imports is in A's export and subscriber list, and in neither of B's;
  - every response class the Worker makes carries `noindex`, the 429 page included.
- `test/build/assets-headers.test.mjs`: the built static assets' `_headers` marks every asset `noindex`.
- `test/media.spec.ts`:
  - an upload in A 404s in B at the same path;
  - each sandbox's seeded logo is one shared object, served at that sandbox's own key and absent at another's;
  - a replaced or removed logo stays in its own sandbox;
  - media is served privately;
  - keys can't escape a sandbox's prefix.
- `test/sessions.spec.ts`:
  - the same cookie reaches the same sandbox, and only its own;
  - forged, tampered and junk cookies are new sessions, not a way in;
  - a cookieless write starts no session, and a connector's cookieless call to `/api/mcp` (since v1.14.0) is refused before any sandbox is chosen;
  - sandbox responses are private.
- `test/sends.spec.ts`: a full send completes with no network egress, and any `fetch` in a sandbox is refused.

## Kestrel integration

### Version pin

`.kestrel-version` holds the Kestrel release tag the demo runs (starting at `v1.2.0`), mirroring getkestrel.dev's own `.kestrel-version`. The build makes a shallow clone of Kestrel at exactly that tag into a gitignored `vendor/kestrel/`, applies the patch set, runs Kestrel's own `npm ci`, and builds:

- the Worker code, which the wrapper imports from Kestrel's `src/`;
- Kestrel's admin client (`scripts/build-client.mjs`: `public/` + `client/` → `dist/public`), which the demo serves as its static assets;
- the build stamp (`scripts/stamp-version.mjs` → the gitignored `src/generated/version.ts`), without which Kestrel's `src/build.ts` fails to import. Since v1.5.0 Kestrel's `npm ci` writes it through its `prepare` script (`scripts/build-package.mjs`), which also builds the npm package's `dist/`; the demo uses only the stamp and `dist/public` from it, and the build stops if the stamp is missing.

Since v1.5.0 Kestrel also ships as the npm package `@kurtbruns/kestrel`: the Worker compiled to one bundle, the built editor, and the migrations. The demo can't build on it, because the patches change the Worker's source and the editor's client code, and the package's bundle and `dist/public` are built from an unpatched tree. Only an unpatched part could come from it, the migrations and the demo publication's files, and those come with the clone anyway.

The demo's wrangler config has to carry what Kestrel's does for its code to bundle: the `Text` rule for `**/*.md` (the demo posts and the setup docs are imported as text) and `nodejs_compat`. The css-inline `.wasm` import needs no rule, since wrangler's default `CompiledWasm` rule covers it, as it does in Kestrel's own config.

A clone rather than a git dependency (`github:kurtbruns/kestrel#v1.2.0`), because npm installs a git dependency without its devDependencies (Kestrel's client build needs esbuild) and without `.git` (so the build stamp would read `dev` instead of the tag), and because a patch set needs a working tree to apply to. It mirrors how getkestrel.dev's CI clones Kestrel at its `.kestrel-version`.

### The `kestrel` module

The wrapper reaches Kestrel's code through one module specifier, `kestrel`. For bundling, wrangler (`alias` in `wrangler.jsonc`) and Vitest (`resolve.alias`) resolve it to `kestrel/entry.ts`, which re-exports from the patched tree: the default export, `getConfig`, `seedDatabase`, `HttpError`, the build stamp, the fake transport's outbox functions (for the tests of patch 0002), and the demo images and migrations the build indexes in `vendor/demo-assets.ts`. For type-checking, `tsconfig.json` `paths` resolves it to `src/types/kestrel.d.ts` instead, a hand-written declaration of just that slice. This repo's `tsc` therefore never type-checks Kestrel's source, which would drag in Kestrel's own generated global `Env` and ambient `*.md` declarations. Kestrel's own typecheck, run on the patched tree, covers Kestrel. The two files must stay in step, and the Worker tests catch a mismatch at runtime.

### The patch set

`patches/` holds a few small `git` patches against the pinned tag. The build applies them in filename order right after cloning (`git apply`), before anything is built. A patch that doesn't apply cleanly stops the build, so a Kestrel release that changes the patched lines fails loudly in the PR that bumps `.kestrel-version`, never quietly in production. CI applies them on every PR.

Rules for a patch:

- One concern per patch, named for it (`0001-demo-auth.patch`), with a header comment that says what it changes, why the demo needs it, and which issue added it.
- As small as the concern allows. A patch changes behavior only where the demo needs it to, and touches no invariant from Kestrel's `docs/SPEC.md` (the send state machine, the single render path, the consent rules).
- If a fix is one self-hosters would want too, it goes upstream as a Kestrel issue instead, and the patch is dropped once a release carries it.

Planned patches:

| Patch | What it changes | Issue |
| --- | --- | --- |
| `0001-demo-auth` | `authenticate` (`src/auth/middleware.ts`) returns a demo principal for every request, with `via: "demo"`; the principal's `via` union (`src/router.ts`) and the auth-mode types (`shared/settings.ts`, and since v1.14.0 whoami's `WhoamiResponse` in `shared/who_acted.ts`, which the client's session is) accept `demo`, the curl snippet shows no credential headers, and the settings label (`client/settings/deploy.ts`) names it. Since v1.7.0 `whoami` and the settings reflection report the principal's `via`, so they say `demo` unpatched. `authenticate` keeps Kestrel's return type, `access_unidentified` included (v1.14.0), though it never returns it | #2, #31, #46 |
| `0002-fake-outbox-bound` | keeps only the newest 500 messages in the fake transport's and the fake notifier's in-memory outboxes, and the newest 5,000 keys in the fake transport's batch-key map (dedup is best-effort: the window is shared by every sandbox in an isolate, and a missed dedup only adds a duplicate row to the fake outbox, never a second delivery record) | #6 |
| `0003-demo-noindex` | adds a rule giving every static asset `X-Robots-Tag: noindex` to Kestrel's `public/_headers` (static assets are served before the Worker runs, so their headers come only from that file) | #7 |
| `0004-demo-chrome` | Kestrel's dev pill, extended into a split pill in the bottom-right corner of every surface: a "Demo" tag opening a note about the sandbox, beside "Open dashboard" on every public page as served and "View publication" in the editor, whose note also holds the reset step; in demo auth mode, the editor's "Demo sandbox" chip, styled as Kestrel's "Local dev" marker; a client spec for the editor side | #9, #23, #52 |
| `0005-demo-import-limit` | `maxImportRows` (`src/services/imports.ts`) gives the sandbox 1,000 rows an import, with a reason naming the demo, where an instance off Workers Free's limits takes 10,000. The format route reports it as `limits.max_rows`, and a larger file gets Kestrel's own 400 `too_many_rows`. The export's page size is untouched | #35 |

Why a patch set, over the two alternatives considered:

- **A seam in Kestrel** (an exported `createHandler({ authenticate })`, briefly filed as kurtbruns/kestrel#471 and closed): general and tested upstream, but it would make Kestrel ship, document and maintain an extension point whose only consumer is this demo, which cuts against keeping Kestrel small for self-hosters.
- **A full fork** (a `kestrel-demo` repo or long-lived branch): no build-time machinery, but every release becomes a merge in a second repo with its own history and CI, which is a lot of process for a few dozen changed lines.

On the patched tree, Kestrel's own client specs, typecheck and CSS token check pass. Its server specs that assert what the patches change on purpose fail there: the auth specs under `0001` (the 401s, the auth mode, and since v1.9.0 the import specs that commit as a service token or expect the signed-in tester's address on the import record, and the specs that expect the tester's address as a revision's author or, since v1.12.0, a service token named in Resolve's audit note, and since v1.14.0 the who-acted specs that expect a named person or a service token as whoami's principal, a revision's author, an import's principal, or a send's `scheduled_by`, `rescheduled_by`, `canceled_by` and `resolved_by`: 24 of the 35 in `test/send_actors.spec.ts`, 5 of the 7 in `test/who_acted.spec.ts`, the `test/mcp.spec.ts` specs that check who a tool acted as or expect a cookieless call's 401, and since v1.16.0 the 8 specs in `test/action_logs.spec.ts` that expect a service token's action line to say `principal: "service"`, since every request is the demo's human principal), and under `0004` the dev-badge specs in `test/archive.spec.ts` and the two web-version specs in `test/render_endpoints.spec.ts` that compare the archive page, less Kestrel's dev pill, with the web version, and under `0005` the two import specs in `test/imports.spec.ts` that expect 10,000 rows when the budget says Workers Paid. Everything else passes, including its send, notification and fake-transport specs.

The cost of patches is that they touch Kestrel's internals, so a refactor upstream can break them; they fail at build, which is the right place. The demo is then "Kestrel at the pinned tag plus these patches", and the patch list is short enough to read in full.

### Updating the demo

When Kestrel cuts a release: bump `.kestrel-version`, rebuild (which re-applies the patch set; fix or drop any patch that no longer applies, or that the release made unnecessary), run the demo's checks (the D1 adapter suite against the new migrations, the isolation tests, a seed smoke test), and redeploy. Existing sandboxes were migrated at the old version. The DO records the migrations it applied (in wrangler's `d1_migrations`, which Kestrel reads since v1.8.0) and the Kestrel version that seeded it (the seed marker in `demo_meta`), and a sandbox from an older version is reset on its next request rather than migrated in place: sandboxes are disposable, and a reset is always correct. The procedure is the `update-kestrel` skill (`.claude/skills/update-kestrel/`), built on `scripts/kestrel-delta.mjs`. The script reports what a release changes against the demo: the changelog, migrations, what the wrapper imports, every patch's files and whether each patch still applies, and new D1 API uses.

### The D1-compatible adapter

`env.DB` is an object that implements the slice of the D1 API Kestrel uses, over the DO's synchronous `ctx.storage.sql`. Surveyed at v1.17.0:

- `prepare(sql)` (about 175 call sites), `bind(...values)`, `first()` and `first(column)`, `all()`, `run()`, and `batch(statements)` (30 sites, counting the `batch<T>(` form, in `db/imports`, `db/notifications`, `db/subscribers`, `db/sends`, `db/posts`, `db/seed`, `send/schedule`, `send/remake`, `send/budget`).
- `raw()` and `exec()` appear only as pass-throughs in `send/budget.ts`'s metering wrapper. No call site uses them directly, and nothing uses `dump()` or `withSession()`. The adapter still implements `raw()` and `exec()` so the metering wrapper stays type-correct.
- Results: `all()` and `run()` return `{ results, success, meta }`. Kestrel reads `meta.changes` (25 sites), so it must be exact. DO SQLite's cursor reports `rowsWritten`, which also counts index writes, so the adapter reads SQLite's own `changes()` (and `last_insert_rowid()`) after each statement and uses `rowsWritten` only to tell whether the statement wrote at all, which a SELECT following a write needs.
- Statement shapes: since v1.9.0 the send loop moves a batch of deliveries with one `UPDATE … FROM json_each(?) … RETURNING` inside a `batch`, and its `meta.changes` must count only the rows it moved. DO SQLite runs it, and `test/d1-adapter.spec.ts` holds the adapter to it. Kestrel's own tests also read `meta.rows_read` and `meta.rows_written` (`test/support/d1_guard.ts`), but only on their own D1, never through the adapter, so it doesn't report them.
- `batch` must be atomic: all statements commit or none do, which the adapter gets from `ctx.storage.transactionSync`. Since v1.9.0 an import's commit applies the whole plan as one batch (`db/imports`), so a refused row rolls back the import rather than leaving half of it. Kestrel also uses `batch` as a consistent multi-SELECT read (the send list and feed read a sequence number, counts and rows together), so every entry returns its full rows, all read inside that one transaction.
- Error text matters: `send/schedule.ts` recognizes a double schedule by matching `UNIQUE constraint failed: sends.post_id` in the error message, so the adapter must let SQLite's constraint messages through unchanged.
- Schema features: every table is `STRICT`, queries use `json_each` to bind lists, some use `RETURNING`, and foreign keys are enforced, as on D1. DO SQLite supports all four, and `test/d1-adapter.spec.ts` proves it on Kestrel's own schema (every table, index and column the migrations leave, replayed in order so a dropped index or a rebuilt table counts), ending with Kestrel's full Field Notes seed run through the adapter.
- Held to D1's limits: at most 100 bound parameters, `undefined` refused as a bind value, and `first(column)` refusing an unknown column, so the demo is no more lenient than a real deployment.
- Migrations: `src/d1/migrate.ts` applies Kestrel's `migrations/*.sql` in name order, each inside `transactionSync` (DO SQLite refuses `BEGIN`/`COMMIT` in `sql.exec`), and records each in wrangler's own `d1_migrations` table, in wrangler's shape, so a re-run is a no-op. Kestrel reads that table: since v1.8.0 it refuses to serve a database missing a migration it ships (`schema_behind`), so the record has to be the one wrangler keeps. A sandbox migrated before v1.8.0 kept it in `demo_migrations`, which the runner carries over once. DO SQLite's `sql.exec` refuses a script whose tail after the last `;` is only a comment (after running what came before it), where wrangler's runner accepts one, so every script gets a trailing no-op statement. The SQL comes from the same generated module as the demo images, `vendor/demo-assets.ts`, so a Kestrel release with a new migration needs no change here.

### Seeding

The seed is Kestrel's own: `seedDatabase(env, config, images, logo)` in `src/dev/seed.ts`, the function behind `POST /api/dev/seed`. Its posts and publication file are imported as text from `demo/`, and its images are passed in as files. The build gathers every image beside a post's `index.md` (named `<bundle>/<file>`) and the logo `publication.md` names into the generated `vendor/demo-assets.ts`. That's a superset of what Kestrel's `cli/seed.mjs` uploads, which is harmless because the seed looks each image up by the name its post uses. The Worker bundles that module, with the images as `ArrayBuffer`s through wrangler's `Data` rule, so a release that adds or renames a demo image needs no change here. The wrapper calls it directly inside the DO rather than through the dev route, which a deployed config never registers. The seed writes post images to `env.MEDIA` under deterministic keys, which is what lets the media wrapper share one read-only copy (see "Media"). Its logo is the exception: since v1.6.0 Kestrel gives every logo upload a key of its own, the seed's included, and the wrapper aliases it. Since v1.14.0 the seed records who acted on each seeded send and who committed the seeded import as the publication's first test recipient, in the editor, so a seeded send's page names that address where a send the visitor schedules names `demo@getkestrel.dev`. That's cosmetic, and left as Kestrel seeds it.

### Auth

The original plan was to run the sandbox in Kestrel's `dev` auth mode. That doesn't work, by design. `getConfig` (`src/env.ts`) only resolves `devAuthSecret` in a "dev-shaped" env: fake provider, no Access team domain, **and a loopback `APP_ORIGIN`** (`localhost` or `127.0.0.1`). With `APP_ORIGIN=https://demo.getkestrel.dev`, `devMode` is false, so the `/api/dev/*` routes (including `/api/dev/token`, the editor's token bootstrap in `client/main.ts`) are not registered, bearer tokens are ignored, and every admin route answers 401. The gate itself is closed.

The demo-auth patch opens it for the sandbox only: `authenticate` in `src/auth/middleware.ts` returns a human principal (`demo@getkestrel.dev`) for every request, with `via: "demo"`. Since v1.7.0 Kestrel reports `auth.mode` in `GET /api/whoami`, and `authMode` in the Settings reflection, from the principal's `via` (how the request signed in), so both say `demo` with no patch of their own; the patch only widens the `via` and auth-mode types to accept it. That is correct here, and only here, because a request reaches a sandbox's Kestrel only through its owner's cookie (see "The safety property"): whoever holds the cookie is that sandbox's publisher. Everything else in Kestrel's gate stays as shipped: `devMode` is still false, so the `/api/dev/*` routes stay absent; admin writes still refuse cross-site requests; admin responses are still `no-store`. The client boots unchanged: with no token it tries `/api/dev/token`, gets a 404, and the `whoami` probe then succeeds without a header.

Since v1.14.0 a person's principal also carries the client the request came through, from its `Kestrel-Client` header: `requireAuth` adds it to the demo principal as it does to any person's, so the visitor's own acts record as `demo@getkestrel.dev` with the editor as their client (the editor sends `Kestrel-Client: editor` on every call, and the Worker forwards request headers unchanged). Only a commit through the editor may grow a scheduled send's audience, which the editor's own import satisfies. Kestrel 1.14.0 also serves an MCP server at `/api/mcp`, for Claude Desktop and claude.ai as a custom connector signed in through Access. The demo can't be connected that way: a connector's servers carry no demo cookie, so their `POST` gets the Worker's own 403 `no_session` before any sandbox is chosen, and a cookieless `GET` starts a sandbox like any other and gets Kestrel's 405. Inside a visitor's browser session the route is answered by their own sandbox like every path, and its tools run the API's routes in-process, so they reach nothing outside it.

Rejected along the way: a loopback-origin shim (`APP_ORIGIN=http://localhost` with `ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE` pointed at the real host and a per-sandbox `DEV_AUTH_SECRET`), which works against v1.2.0 unpatched but impersonates the very predicate Kestrel uses to fence local dev, and re-exposes the dev routes the wrapper would then have to block.

### Static assets and demo chrome

Kestrel serves `/dashboard/` from Workers static assets (`assets.directory: ./dist/public`, `not_found_handling: none`), which bypass the Worker. The demo serves the same built tree the same way. Since the shell is identical for every visitor, serving it from assets doesn't weaken the safety property. The demo chrome is `patches/0004-demo-chrome.patch`, so it lives in Kestrel's own markup and CSS tokens rather than being injected from outside.

The chrome is one element on every surface: Kestrel's dev-only "Open dashboard" pill, extended into a split pill in the same bottom-right corner, in the same accent. Its inverted tag reads "Demo" and is the toggle of a `<details>`, so it opens with no script, onto a short note: "Kestrel demo sandbox. Only this browser can see it. Emails never really go out, and it resets after a day away." with a quiet "About Kestrel" link. The other half of the pill is the one action that matters on that surface.

- **Every public page:** the reader shell (the landing page, the archive, the subscribe, confirm, unsubscribe and not-found pages) and a hosted post page, including an email-only post at its unlisted link (since v1.12.0), show "Demo | Open dashboard →", linking to `/dashboard/`. The note adds that the demo can be reset from the dashboard. It rides the injection points of Kestrel's dev pill (`devDashboardStyle` and `devDashboardBadge` in `src/lib/page.ts`), which reach only pages as served, never a frozen render or a sent email (I3). Those helpers emit the demo pill in the dev pill's place whenever a caller passes the dashboard URL, and `devDashboardUrl` (`src/routes/reader.ts`), which only the served pages call, always gives `/dashboard/` in this build. Settings' Reader pages previews and the editor's web version (both new in v1.6.0) show no pill, as upstream's show no dev pill: upstream keeps the previews pill-free by turning `devMode` off for them, which is already off here, so the patch marks a preview's config `readerPreview` instead, and the web version passes no URL. It wears the dev pill's accent tokens and carries no form and no script, so it works under every public page's policy (`script-src 'none'`, and `form-action 'none'` on a post page).
- **The editor:** when `whoami` reports `auth.mode === "demo"`, the identity chip reads "Demo sandbox" with no sign-out link, in the muted italics of Kestrel's own "Local dev" marker rather than the accent, since it is a label and not something to click, and the pill reads "Demo | View publication ↗", linking to `/` like the sidebar's own link. That matters most in the editor and the docs room, which hide the sidebar. The pill is rendered once, on `body` outside the routed view, so navigating never clears it. A few lines of script close its menu on Escape or a click outside.
- **Nothing is added to the editor's height.** The pill is fixed, so no layout makes room for it and the editor never scrolls because of it. It sits on the header's z-index rung, above the content but below the phone drawer, the menus, the toasts and the modals, and steps up over the save bar while it shows (`body:has(.savebar.show)`). Its note's height is capped by the room above it, and scrolls on a short screen. It's clear of the phone's menu button (top left), "New post" (top right), and the toasts, which rise above it on a phone.
- **Reset lives in the editor only.** Resetting is a publisher action, and keeping it off the public pages means they need no form. In the editor's note, "Reset demo…" opens a nested step, another `<details>`: "Discard everything you've changed and restore the sample?", then **Reset**, a form posting to `/_demo/reset` (same-origin; the editor's static assets set no `form-action`), and Cancel, which closes the step. `GET /_demo/reset` serves no page: the Worker answers it (and `HEAD`) with a 303 to `/dashboard/` before reading the session, so an old link still lands where the reset is and starts no sandbox of its own.
- **SPEC §11** says no public page links into the Access-gated admin, with the dev-only shortcut as its one exception. The pill's "Open dashboard" link departs from that on purpose: the demo's editor has no Access wall, and each visitor's editor is their own sandbox, so the rule's reason doesn't hold. No I-invariant is touched.

## Media

`env.MEDIA` is `SandboxMedia` (`src/media.ts`), a wrapper with the slice of the R2 binding's shape Kestrel uses: `get`, `put` (with `httpMetadata`) and `delete`. It also has `head` and `list` for the demo's own use.

- **Scoped keys.** Every key is rewritten to `sessions/<sandbox DO id>/<key>`, so a sandbox can only address its own objects. A key with an empty, `.` or `..` segment, or a leading `/`, is refused with Kestrel's own `HttpError`: a 404 for a read (Kestrel's router decodes `/media/:key`, so `..%2F` arrives as `../`) and a 400 for a write, never a 500. `list` returns only the sandbox's own objects, with the prefix stripped.
- **Shared seed images.** Kestrel's seed is given a separate view of the sandbox's media (`seedView`, in a seed-only env) whose `put` writes a prefix every sandbox shares, `seed/<kestrel tag>/`, once (skipped if the object is already there), so seeding a new sandbox writes no image bytes. The logo's key differs in every seed (`branding/logo/<time>-<random>`, Kestrel's `newLogoKey`), so the seed view stores it once at a fixed shared name, `branding/logo/seed`, and records the sandbox's key as an alias of it in the sandbox's SQLite (`demo_media_aliases`). Without that, every new sandbox would leave a logo of its own in the shared prefix, which nothing deletes. Another sandbox holds no alias for that key, so it reads as absent there. Only the seed ever holds that view: the bucket Kestrel's request handlers see can never write the shared prefix. A sandbox's read of a key it doesn't hold falls back to that prefix. A re-seed first clears the sandbox's own uploads (which Kestrel's `resetAll` can't reach), and the seed view drops anything that would shadow a seed key, so a re-seed restores the seed's images. Old tags' `seed/` prefixes are left in place; they're small, and nothing may delete the current tag's.
- **Tombstones.** Deleting a key records a tombstone in the sandbox's SQLite, so a deleted seed image (a deleted post's cover) stays deleted for that sandbox rather than falling back to the shared copy. Only a write that lands clears it: a refused or failed upload leaves the key deleted.
- **Caps.** Uploads are capped at 2 MB per object (which binds post images; Kestrel's own caps are 5 MB for those and 512 KB for the logo) and 20 MB per sandbox, with the byte count kept in the sandbox's SQLite. The size is checked and reserved with no await in between, before the bytes go to R2, so parallel uploads (a DO serves other requests while it awaits R2) can't pass the cap together. A failed write gives the reservation back. Over a cap, `put` throws Kestrel's own `HttpError("body_too_large")`, which Kestrel's router answers as a 413 with its usual error body, and nothing is written. The DO also refuses an upload request that declares more than the per-object cap plus a multipart allowance (413), or no `Content-Length` at all (411), before Kestrel reads the body.
- **No shared caching.** Seeded post ids are the same in every sandbox, so one `/media/...` URL names different bytes in different sandboxes. The Worker makes every sandbox response private ("Session identity"), so Kestrel's `public, max-age=3600` on media becomes `private, max-age=3600` with `Vary: Cookie`, and no shared cache keeps one visitor's copy for another.
- **Cleanup.** `clear()` deletes everything under the sandbox's prefix and its records (sizes, tombstones and aliases), for the idle-TTL cleanup and reset (#8). The shared seed prefix is never deleted by a sandbox.

## Sends

- **The fake transport only.** `sandboxEnv` fixes `PROVIDER=fake`. It has to name it: since v1.7.0 an unset `PROVIDER` means no provider is connected (`none`), which refuses every send, rather than the fake. Since v1.8.0 Kestrel also refuses `fake` off a loopback origin unless the env opts in, so `sandboxEnv` sets `ALLOW_FAKE_PROVIDER: "true"`. It declares no `NOTIFY` binding, so publisher notifications go through the fake provider too (`notifyChannel` resolves to `provider` deployed, `fake` on a loopback dev origin). As a second check, the DO resolves Kestrel's own config before migrating and refuses to run unless the provider is `fake` and notifications aren't Cloudflare's email (`checkSandboxConfig`).
- **The alarm drives the sweep.** The DO's alarm calls Kestrel's own `scheduled()` with a `ScheduledController`-shaped `{ cron: "* * * * *", scheduledTime, noRetry }`, collects its `waitUntil` work, and awaits it. A tick that fails is logged, as Kestrel's own cron would, and the next one comes from re-arming, not the runtime's alarm retries. After every request and every sweep, the DO re-arms the alarm for `nextWake`, the earliest reason to wake: a minute from now while a send is `sending`, and the earliest scheduled send's `fire_at`. The idle expiry ("Lifecycle") is a third term. Every reason to wake is a term in `nextWake`, so the one alarm always serves the soonest, and a seeded sandbox with nothing to send wakes only at its expiry. There is no Cron Trigger, so no single tick sweeps every sandbox. The DO reads Kestrel's `sends` table directly (read-only) to decide this, so a Kestrel release that changes those columns fails here loudly. With the plain fake transport, a send is `sending` for at most one tick (or one five-minute lease after a crash), and nothing halts or waits on receipts.
- **Fast enough to watch.** `MIN_LEAD_SECONDS=60` (Kestrel's floor) keeps a demo send watchable within a visit. `SUBREQUEST_BUDGET=1000` (Kestrel's cap) lets a send finish in one tick, since the adapter's statements are local SQLite calls, not D1 subrequests. Since v1.9.0 Kestrel also reads that setting as the Workers plan: left at Free's default it warns before a send or import that may spend D1's daily written rows (the `daily_writes` condition, the Schedule dialog's and scheduled banner's warning, `freePlanLimits` in the settings reflection), and takes 1,000 rows an import and an export page. A sandbox's SQLite has no such daily allowance, so those warnings would be false there, and the sandbox stays above that default. Imports are capped at 1,000 rows anyway, by `patches/0005-demo-import-limit.patch` rather than the budget, since imports aren't rate-limited and each one grows the visitor's SQLite until the idle wipe. The export keeps Kestrel's 10,000-row pages, since a read stores nothing. The in-app Docs tab, Kestrel's own pages (since v1.11.0 "Bring your existing list" in its Publishing set, whose last section is the import format), still says an instance on Workers Paid takes 10,000 rows an import, adding that the import screen says which limit applies. The demo leaves it, because the format route and the `too_many_rows` refusal carry the demo's own limit and reason.
- **No egress.** `src/egress.ts` replaces `globalThis.fetch` with one that refuses every request. It's installed by the Worker entry's first import (`src/egress-install.ts`), and ES modules evaluate in import order, so the block is in place before any of Kestrel's modules are even evaluated. Every outbound call Kestrel can make goes through it: SES through aws4fetch, SNS signing certificates and subscription URLs, Access's JWKS. Each resolves the global `fetch` when it's called. In the sandbox none of those paths is even reachable, since the webhook routes delegate to the active provider, always the fake. So the block is a backstop, and the tests show a full send completing with nothing refused, and a refused fetch counted. It's isolate-wide, which is fine: the Worker reaches its sandboxes and R2 through bindings, never the global fetch.

### Module-level state in Kestrel

DOs of one class can share an isolate, so anything Kestrel keeps at module scope is shared across the sandboxes in that isolate, not per sandbox. At v1.17.0 that is:

- `providers/fake.ts`: the in-memory `outbox` of every message "sent" and the `sentKeys` map, keyed by batch and address. Both grow without bound in a long-lived isolate.
- `notify/fake.ts`: the notifications outbox, which grows the same way.
- `providers/simulate.ts`: the simulation's maps (inert here, since the simulation only engages when dev-shaped).
- `index.ts`'s router cache, `auth/access.ts`'s JWKS cache, and `docs/index.ts`'s tables of the bundled docs (since v1.10.0 its two sets, their pages, and the map of links between them, and since v1.11.0 the map from each removed page's slug to the page that now holds it), which hold config and the bundled Markdown, not visitor data. `schema.ts`'s set of the databases already seen with every migration holds only database objects, each sandbox's own, and its two remembered log lines name migrations, not visitor data. `providers/ses.ts`'s tables of SES error types and failures are constants. `lib/body.ts`'s two maps of each request's body and form, read once (since v1.13.0), are `WeakMap`s keyed by the `Request` itself, so an entry is reachable only through the request it belongs to and goes with it. `mcp/tools.ts`'s map of each router's tools (since v1.14.0) is a `WeakMap` keyed by the router, holding route metadata, not visitor data. Its map of the refusal code behind each failed tool result (since v1.16.0, for the `mcp.call` log line) is a `WeakMap` keyed by that result object, holding a route's error code, not visitor data, and reachable only through the result it belongs to.

None of this is reachable over HTTP outside dev mode (the outbox is read only by `/api/dev/outbox`), so it is not a cross-sandbox read, but the outboxes are an unbounded memory leak. The fake transport's batch-key map also ignores which sandbox a key came from, though keys embed per-sandbox send ids, so they can't collide. The `0002-fake-outbox-bound` patch caps the two outboxes and the idempotency map at a fixed size, keeping the newest entries. (Briefly filed upstream as kurtbruns/kestrel#470 and closed: only the demo runs the fake transport in a long-lived production isolate.)

## Lifecycle

- **Idle TTL.** Each request records `last_seen` in the sandbox's `demo_meta`, before it runs (so an expiry alarm delivered while it awaits I/O sees a visitor) and again after. The value is rewritten at most once a minute. The idle expiry, `last_seen` plus 24 hours (`IDLE_TTL_MS`), is a term in `nextWake`. When the alarm fires past it, the DO wipes itself: its uploads under its R2 prefix (never the shared seed images), its whole SQLite database (`deleteAll`), and its alarm. A request with the same cookie afterwards gets a fresh, freshly seeded sandbox. A wipe that fails is logged and retried five minutes later by the alarm itself, so a sandbox never outlives the runtime's own few retries. An alarm never seeds: one that finds a sandbox wiped or never used clears itself, and one that finds it seeded by another Kestrel release wipes it.
- **Reset.** The editor's demo pill has a "Reset demo…" step (#9's chrome, reworked in #23) whose Reset button posts to `/_demo/reset`, a wrapper route outside Kestrel's paths. A `GET` of that path resets nothing and answers a 303 to `/dashboard/` without starting a session. The POST is refused unless it comes from the demo's own pages: a browser's `Sec-Fetch-Site` must be `same-origin`, or lacking that, its `Origin` must match. A reset costs as much as a new sandbox, so the Worker counts it against the same per-network limit as new sessions. A reset with no session (an expired cookie) is sent back to the editor, which starts one. The reset wipes the sandbox as the idle TTL does, migrates and seeds it again, and answers a 303 to `/dashboard/`.
- **A new Kestrel release.** On its first start after a deploy, a sandbox seeded by another Kestrel release (its `seeded_kestrel` marker) is wiped and seeded fresh rather than migrated in place ("Updating the demo").
- **Rate limit.** Creating a session costs a migrate, a seed of several hundred statements, and some storage, so new sessions are rate-limited per network with the Workers Rate Limiting binding `NEW_SESSIONS`: 10 a minute per IPv4 address (`cf-connecting-ip`), or per IPv6 /64, since one IPv6 client usually holds a whole /64 and could rotate through it. Past the limit, the visitor gets a short 429 page asking them to wait a minute, with no cookie and no sandbox. A returning visitor's cookie skips the limit. Requests that don't need a sandbox (static assets, `/favicon.ico`, `robots.txt`, `/health`, a `GET` of `/_demo/reset`) never create one.

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
| `SUBREQUEST_BUDGET` | `1000` | sends finish in one tick; off Workers Free's limits, so no D1 daily-writes warnings (imports are capped at 1,000 rows by patch `0005`) |
| `ACCESS_*`, `DEV_AUTH_SECRET`, `NOTIFY`, provider credentials | unset | see "Auth" and "Sends" |

## Open questions

- **Landing.** Should `/` stay Kestrel's public landing page (the visitor's own sandbox), or redirect first-time visitors to `/dashboard/`? Kestrel's rule that no public page links into an admin path is about Access-gated deploys, but the demo pill offers the way in either way.
- **TTL and storage cost.** 24h idle is a guess. Measure the per-sandbox SQLite size after seed and pick the TTL and the rate limit together.
