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
- Changing Kestrel's behavior for self-hosters. Kestrel gains only small, general seams.

## Why a separate repo

getkestrel.dev is a static Hugo site that owns no data. Adding a stateful Worker with Durable Objects, R2 and per-visitor storage to it would muddle its deploy, its CI and its purpose. Kestrel itself should stay small and legible for self-hosters, who have no use for sandbox infrastructure. So the demo lives here, as a thin wrapper around a pinned Kestrel release. Anything Kestrel needs to make that wrapper possible is filed as a small, general issue in the kestrel repo and linked from this repo's issues. The website-side work (the DNS route, the "Try the live demo" CTA, the hero frame linking here) stays in kurtbruns/getkestrel.dev#16.

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

The wrapper does not fork Kestrel. It imports Kestrel's own default export (`src/index.ts`, an `ExportedHandler` with `fetch(request, env, ctx)` and `scheduled(controller, env, ctx)`) and calls it with a sandboxed `env`. Kestrel reads every binding off `env` per request (`routerFor(env)` builds and caches the router from `getConfig(env)`; every `db/` function takes `env.DB` as an argument), so swapping the bindings is enough to swap the world it runs in.

### Request flow

1. A request arrives at the demo Worker. Requests for Kestrel's static assets (`/dashboard/` and its CSS/JS, the favicon) are served from the Workers assets directory. They are the same bytes for every visitor and carry no data.
2. For anything else, the Worker reads the session cookie. With no valid cookie it creates a new session (subject to the per-IP rate limit), sets the cookie, and continues. Crawlers are kept away by `robots.txt` and `noindex` so they don't mint sandboxes.
3. The Worker derives the Durable Object id from the session and forwards the request to that DO.
4. On its first request the DO applies Kestrel's `migrations/` to its SQLite and runs the Field Notes seed. Then it calls Kestrel's `fetch` with the sandboxed env and returns the response, adding `X-Robots-Tag: noindex`.

### Session identity

The cookie carries a random 256-bit session token (`HttpOnly; Secure; SameSite=Lax`). The DO id is `idFromName(HMAC(SESSION_SECRET, token))`, so the only way to reach a sandbox is to hold its token, and a token can't be derived from a DO id, a URL, or anything Kestrel emits. Nothing in a URL ever selects a sandbox.

## The safety property

**A visitor can only ever see their own sandbox.** Every request, including the public `/archive/*` pages, the landing page at `/`, and `/media/*`, is answered by the visitor's own Durable Object, chosen by their cookie and nothing else. So nobody can mint a demo.getkestrel.dev URL that shows anyone else their content. If someone writes an offensive post, publishes it, and shares the archive link, everyone who opens that link sees the pristine Field Notes sandbox their own cookie leads to (a fresh one, if they have none), and the post's slug simply 404s. The demo can't be used to host or distribute content.

This is the main reason for the per-visitor design over a single shared demo instance, and it is tested explicitly (session A cannot read session B's posts, archive pages or media). Supporting measures:

- Every demo response carries `X-Robots-Tag: noindex`, and `robots.txt` disallows everything, so no sandbox's content is indexed.
- Mail can't leave: `PROVIDER=fake` is fixed in the sandbox env, no `NOTIFY` binding is declared, and outbound `fetch` is refused inside the DO (see "Sends").
- Visitor uploads are capped and scoped to the session's R2 prefix, and are served only through the session's own DO.
- Sharing a cookie shares a sandbox. That is the visitor's own choice with their own browser state, not a link anyone can be handed.

## Kestrel integration

### Version pin

`.kestrel-version` holds the Kestrel release tag the demo runs (starting at `v1.2.0`), mirroring getkestrel.dev's `.kestrel-docs-version`. The build fetches Kestrel at exactly that tag (a shallow clone into a gitignored `vendor/kestrel/`, or a git dependency; the scaffold issue picks one) and builds:

- the Worker code, which the wrapper imports from Kestrel's `src/`;
- Kestrel's admin client (`scripts/build-client.mjs`: `public/` + `client/` → `dist/public`), which the demo serves as its static assets;
- the build stamp (`scripts/stamp-version.mjs` → the gitignored `src/generated/version.ts`), without which Kestrel's `src/build.ts` fails to import.

The demo's wrangler config has to carry what Kestrel's does for its code to bundle: the `Text` rule for `**/*.md` (the demo posts and the setup docs are imported as text), the css-inline WASM module, and `nodejs_compat`.

### Updating the demo

When Kestrel cuts a release: bump `.kestrel-version`, rebuild, run the demo's checks (the D1 adapter suite against the new migrations, the isolation tests, a seed smoke test), and redeploy. Existing sandboxes were migrated at the old version. The DO records the Kestrel version and migration list it applied, and a sandbox from an older version is reset on its next request rather than migrated in place: sandboxes are disposable, and a reset is always correct. The procedure lives in a skill or a documented script, like getkestrel.dev's `refresh-from-kestrel`.

### The D1-compatible adapter

`env.DB` is an object that implements the slice of the D1 API Kestrel uses, over the DO's synchronous `ctx.storage.sql`. Surveyed at v1.2.0:

- `prepare(sql)` (about 143 call sites), `bind(...values)`, `first()` and `first(column)`, `all()`, `run()`, and `batch(statements)` (23 sites, in `db/notifications`, `db/subscribers`, `db/sends`, `db/posts`, `db/seed`, `send/schedule`, `send/remake`, `send/budget`).
- `raw()` and `exec()` appear only as pass-throughs in `send/budget.ts`'s metering wrapper. No call site uses them directly, and nothing uses `dump()` or `withSession()`. The adapter still implements `raw()` and `exec()` so the metering wrapper stays type-correct.
- Results: `all()` returns `{ results, success, meta }`; Kestrel reads `meta.changes` (16 sites), so `run()` must report it accurately.
- `batch` must be atomic: all statements commit or none do, which the adapter gets from `ctx.storage.transactionSync`.
- Error text matters: `send/schedule.ts` recognizes a double schedule by matching `UNIQUE constraint failed: sends.post_id` in the error message, so the adapter must let SQLite's constraint messages through unchanged.
- Schema features: every table is `STRICT`, queries use `json_each` to bind lists, and some use `RETURNING`. DO SQLite supports all three; the adapter test suite proves it by running Kestrel's own migrations and a representative slice of its queries.
- Migrations: the adapter's migrate step applies `migrations/*.sql` in order and records them in its own table. DO SQLite refuses `BEGIN`/`COMMIT` in `sql.exec`, so each file runs inside `transactionSync`.

### Seeding

The seed is Kestrel's own: `seedDatabase(env, config, images, logo)` in `src/dev/seed.ts`, the function behind `POST /api/dev/seed`. Its posts and publication file are imported as text from `demo/`, and its images (`demo/posts/*/*.webp`, `demo/field-notes-logo.png`) are passed in as files, which the wrapper bundles from the pinned checkout. The wrapper calls it directly inside the DO rather than through the dev route, which a deployed config never registers. The seed writes post images and the logo to `env.MEDIA` under deterministic keys, which is what lets the media wrapper share one read-only copy (see "Media").

### Auth (the one place the chosen design had to change)

The original plan was to run the sandbox in Kestrel's `dev` auth mode. That doesn't work, by design. `getConfig` (`src/env.ts`) only resolves `devAuthSecret` in a "dev-shaped" env: fake provider, no Access team domain, **and a loopback `APP_ORIGIN`** (`localhost` or `127.0.0.1`). With `APP_ORIGIN=https://demo.getkestrel.dev`, `devMode` is false, so the `/api/dev/*` routes (including `/api/dev/token`, the editor's token bootstrap in `client/main.ts`) are not registered, bearer tokens are ignored, and every admin route answers 401. The `src/app.ts` line that reports `auth.mode` as `dev` whenever Access is unconfigured is only the `whoami` label; the gate itself is closed.

Two ways through, in order of preference:

1. **A Kestrel seam for an embedding host (recommended).** Kestrel exports a handler factory that takes an optional authenticator, `(request, env, config) => Promise<Principal | null>`, used in place of the Access/dev pair, and `whoami` reports its mode (for example `"embedded"`), so the client shows a "Demo sandbox" identity chip rather than "Local dev" or a sign-out link. The default export stays exactly as it is for self-hosters. In the sandbox, the authenticator returns a human principal for every request, which is correct because a request only reaches the DO through its owner's cookie. The client needs no change to boot: with no token it tries `/api/dev/token`, gets a 404, and the `whoami` probe then succeeds without a header. This is tracked as a kestrel-repo issue linked from the spike.
2. **A loopback-origin shim (fallback, no Kestrel change).** Give the sandbox env `APP_ORIGIN=http://localhost`, `ARCHIVE_ORIGIN=https://demo.getkestrel.dev`, `MEDIA_PUBLIC_BASE=https://demo.getkestrel.dev/media`, and a per-sandbox random `DEV_AUTH_SECRET`. That makes the env dev-shaped, so the editor mints its own token as it does locally. The wrapper must then block every `/api/dev/*` route except `token`, and audit what else still emits `APP_ORIGIN` links. It works against v1.2.0 as shipped, but it impersonates the very predicate Kestrel uses as its "this is local dev" fence, so it is a stopgap at best.

The spike issue proves one of these end to end. The design assumes (1) and keeps (2) as the way to unblock the spike if the Kestrel seam isn't released yet.

### Static assets and demo chrome

Kestrel serves `/dashboard/` from Workers static assets (`assets.directory: ./dist/public`, `not_found_handling: none`), which bypass the Worker. The demo serves the same built tree the same way. Since the shell is identical for every visitor, serving it from assets doesn't weaken the safety property. To inject the demo banner ("Sandbox: your changes are private and reset after 24h") and a "Reset demo" control, either route the dashboard's `index.html` through the Worker (`assets.run_worker_first` for that path) and rewrite it with `HTMLRewriter`, or add the snippet to the copied `index.html` at build time. Kestrel's own server-rendered public pages (`/`, `/archive/*`) pass through the DO, so `HTMLRewriter` can add the banner there.

## Media

`env.MEDIA` is a wrapper with the R2 binding's `get`/`put`/`delete`/`head`/`list` shape:

- Keys are rewritten to `sessions/<session-hash>/<key>`, so a sandbox can only address its own objects.
- The seed's images are written once to a shared `seed/<kestrel-version>/` prefix. A sandbox's read of a seed key falls back to that prefix when its own copy is absent, so seeding a new sandbox writes no image bytes.
- Uploads are capped per object and per session (for example 2 MB and 20 MB), and are deleted along with the session. Disabling uploads outright is an acceptable first cut.

## Sends

- `PROVIDER=fake` is fixed in the sandbox env, and the wrapper refuses to start if anything else is configured. No `NOTIFY` binding is declared, so publisher notifications go through the fake provider too (`notifyChannel` resolves to `provider`).
- The send sweep runs from the DO's alarm, which calls Kestrel's `scheduled()` with a `ScheduledController`-shaped `{ cron: "* * * * *", scheduledTime, noRetry }` and the DO's own `ctx` for `waitUntil`. The alarm is armed once a minute while the sandbox has a scheduled or in-flight send and stays idle otherwise. There is no Cron Trigger, so no single tick has to sweep every sandbox.
- `MIN_LEAD_SECONDS=60` (Kestrel's floor) keeps a demo send watchable within a visit. `SUBREQUEST_BUDGET` can go up to Kestrel's 1,000-statement cap, since the adapter's statements are local SQLite calls rather than D1 subrequests.
- No egress: inside the DO, `globalThis.fetch` is replaced with a function that throws, so even a code path Kestrel only takes with a real provider, the SNS signing-cert fetch, or Access's JWKS can't reach the network. A test proves a send completes with outbound fetch refused.

### Module-level state in Kestrel

DOs of one class can share an isolate, so anything Kestrel keeps at module scope is shared across the sandboxes in that isolate, not per sandbox. At v1.2.0 that is:

- `providers/fake.ts`: the in-memory `outbox` of every message "sent" and the idempotency `sentKeys` map. Both grow without bound in a long-lived isolate.
- `notify/fake.ts`: the notifications outbox, which grows the same way.
- `providers/simulate.ts`: the simulation's maps (inert here, since the simulation only engages when dev-shaped).
- `index.ts`'s router cache and `auth/access.ts`'s JWKS cache, which hold config, not visitor data.

None of this is reachable over HTTP outside dev mode (the outbox is read only by `/api/dev/outbox`), so it is not a cross-sandbox read, but the outboxes are an unbounded memory leak. The fake transport's idempotency map also ignores which sandbox a key came from, though keys embed per-sandbox send ids, so they can't collide. The fix is a small Kestrel seam (a bound on the fake outboxes, or exported clear functions), tracked as a kestrel-repo issue. Until then, the wrapper clears them after each sweep through deep imports from the pinned tag.

## Lifecycle

- **Idle TTL.** Every request records `lastSeen`. The DO's alarm also checks the TTL (about 24h); past it, the DO deletes its R2 prefix and calls `ctx.storage.deleteAll()`. The next request with that cookie gets a fresh sandbox.
- **Reset.** A "Reset demo" control posts to a wrapper route (outside Kestrel's `/api`) that wipes the DO's storage and the session's R2 prefix, then re-migrates and re-seeds.
- **Rate limit.** Creating a session costs a migrate, a seed of several hundred statements, and some storage, so new sessions are rate-limited per IP with the Workers Rate Limiting binding. Requests that don't need a sandbox (static assets, `robots.txt`) never create one.

## Configuration of the sandbox env

| Binding / var | Value | Why |
| --- | --- | --- |
| `DB` | D1 adapter over the DO's SQLite | per-visitor database |
| `MEDIA` | scoped R2 wrapper | per-visitor media, shared seed images |
| `PROVIDER` | `fake` | mail never leaves |
| `APP_ORIGIN` | `https://demo.getkestrel.dev` | links, archive URLs, media URLs |
| `ARCHIVE_BASE_PATH` | `/archive` | Kestrel default |
| `SENDING_DOMAIN`, `FROM_ADDRESS`, `AWS_REGION` | the template's example values | required by `Env`, unused by the fake |
| `MIN_LEAD_SECONDS` | `60` | a send fires within a visit |
| `SUBREQUEST_BUDGET` | up to `1000` | sends finish in one tick |
| `ACCESS_*`, `DEV_AUTH_SECRET`, `NOTIFY`, provider credentials | unset | see "Auth" and "Sends" |

## Open questions

- **Auth seam shape.** Does Kestrel accept an authenticator option on an exported handler factory, and what `whoami` mode and identity chip should it report? Until it ships, is the loopback shim acceptable for a public deploy, or only for the spike?
- **How the wrapper consumes Kestrel.** A git dependency (`github:kurtbruns/kestrel#v1.2.0`) runs Kestrel's `postinstall` and keeps imports tidy, but pulls its dev tooling. A build-time shallow clone into `vendor/` is explicit and mirrors getkestrel.dev's docs sync. The scaffold issue decides.
- **Deep imports.** The seed (`src/dev/seed.ts`), `getConfig`, and the fake outbox clears are not part of Kestrel's default export. Importing them from a pinned tag is safe, but they're internal paths that can move between releases. Should Kestrel export a small "embedding" entry point that names them?
- **Alarm cadence vs. cost.** Is "every minute only while a send is scheduled or in flight" enough to keep a demo send live, or should the alarm also run while the visitor is active?
- **Uploads.** Enable capped per-session uploads at launch, or ship with uploads disabled?
- **Landing.** Should `/` stay Kestrel's public landing page (the visitor's own sandbox), or redirect first-time visitors to `/dashboard/`? Kestrel's rule that no public page links into an admin path is about Access-gated deploys, but the demo banner can offer the way in either way.
- **TTL and storage cost.** 24h idle is a guess. Measure the per-sandbox SQLite size after seed and pick the TTL and the rate limit together.
