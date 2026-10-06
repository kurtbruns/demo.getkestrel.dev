---
name: update-kestrel
description: >-
  Move the live demo to a new Kestrel release: bump .kestrel-version, carry the patch set
  across, check what the release changed against the wrapper, and open a draft PR. Use it
  whenever Kestrel cuts a tag and the demo should follow ("update the demo to kestrel
  v1.3.0", "kestrel released, bump the pin", "advance .kestrel-version"), and any time you
  edit .kestrel-version by hand. The bump is one line; regenerating patches, keeping the
  `kestrel` module shim honest, catching new D1 usage, and re-checking what sandbox
  isolation depends on is the point. Also use it when a patch no longer applies after a
  bump, or to run scripts/kestrel-delta.mjs.
---

# update-kestrel

Moves demo.getkestrel.dev to another Kestrel release. Work on a branch off `main` and finish with a **draft** PR that says what changed; never merge it yourself. `DESIGN.md` ("Updating the demo", "The patch set", "The `kestrel` module") explains the pieces.

## 1. See what the release changes

```bash
node scripts/kestrel-delta.mjs                # the pin → the latest release
node scripts/kestrel-delta.mjs --to v1.3.0    # or a given tag
```

With nothing newer, it says so: stop there and tell the user. Otherwise keep its Markdown report; it goes in the PR. It covers:
- Kestrel's changelog between the tags;
- migrations;
- changes to what the wrapper imports or relies on;
- Kestrel's wrangler compatibility and rules;
- for each patch, whether it still applies and which of its files changed;
- new D1 API uses the adapter may not cover.

Read the changelog's *Breaking* and *Upgrading* sections yourself. A behavior change the demo depends on (auth, the seed, the fake transport, `/media`, the public page chrome, the router's error handling) matters even when every patch applies.

## 2. Bump and rebuild

Set `.kestrel-version` to the new tag, then `npm run build -- --force`.

- **A patch that fails to apply** stops the build and names it. Regenerate it against the new tag with the recipe in `patches/README.md`, keeping its header and intent:
  1. Move it, and every patch after it, out of `patches/`.
  2. Run `node scripts/fetch-kestrel.mjs --apply-only`, then commit inside the clone: `git -C vendor/kestrel add -A && git -C vendor/kestrel commit -qm base --allow-empty`.
  3. Fetch the old tag, because the build's clone is shallow and `--3way` needs the old files: `git -C vendor/kestrel fetch --depth 1 origin tag <old tag>`.
  4. Apply the old patch with `git -C vendor/kestrel apply --3way <old patch>`, resolve any conflicts, and finish by hand if needed.
  5. Write the new patch: the old header, then `git -C vendor/kestrel add -A && git -C vendor/kestrel diff --cached`. Put it back in `patches/`, then do the same for the patches after it.
  6. `node scripts/fetch-kestrel.mjs --force` proves the whole set applies and builds from clean.
- **A patch whose change the release now makes itself:** drop it, and remove its row from `DESIGN.md`'s patch table.
- **A patch that applies but whose files changed** (the report's last column): reread it against the new code. Applying cleanly isn't the same as still being right.

## 3. Keep the wrapper's view of Kestrel honest

`tsc` checks the wrapper only against the hand-written `src/types/kestrel.d.ts`, so a signature change in Kestrel passes `npm run check`. For every file the report lists under "What the wrapper imports or relies on", compare what `kestrel/entry.ts` re-exports with the shim, and update the shim to match. Then:
- **New D1 API flagged:** extend `src/d1/adapter.ts` and its tests (`test/d1-adapter.spec.ts`).
- **New migrations:** nothing to do. `test/d1-adapter.spec.ts` checks every table, index and added column they declare.
- **Wrangler changes:** if Kestrel's compatibility date, flags or module rules changed, mirror them in this repo's `wrangler.jsonc`. A newer compatibility date may need this repo's `wrangler` (and so workerd) bumped too.
- **New or changed env vars** (`src/env.ts`, e.g. a new required var or a new optional one with a default): decide whether the sandbox sets it, then update `sandboxEnv` (`src/sandbox.ts`), the `KestrelEnv` shim, `checkSandboxConfig` if it affects the transport or notifications, and the allowlist test in `test/kestrel.spec.ts`.

### Re-check what isolation depends on

The safety property (DESIGN.md) rests on facts about Kestrel that a release can change. Over the `<old>..<new>` diff:
- **Module state:** look for new module-scope state (`const x = new Map/Set`, top-level `let`) in `src/`. DESIGN.md's "Module-level state in Kestrel" lists what's there today. Anything new that holds visitor data and is reachable over HTTP would cross sandboxes in a shared isolate.
- **Routes:** look for new routes in `src/app.ts`. Each must be answered from the visitor's own sandbox (it is, by construction, unless the Worker answers it itself). A new dev-only route must stay behind `devMode`.
- **Outbound calls:** check that each one still resolves the global `fetch` when it's called (not a reference captured at module load), so the egress block (`src/egress.ts`) still covers it. Also look for new `connect()` or WebSocket use.
- **D1 API:** re-survey what Kestrel calls (`.prepare/.bind/.first/.all/.run/.raw/.batch/.exec`, `meta.` fields), beyond the report's section.
- **DESIGN.md:** update the notes that name the release they were checked against ("At v1.2.0" in "Module-level state", "Surveyed at v1.2.0" in the adapter section, and the version in the opening paragraph).

## 4. Check

```bash
npm run check && npm test
(cd vendor/kestrel && npm run typecheck && node scripts/check-css-tokens.mjs)
(cd vendor/kestrel && npx vitest run --project client && npx vitest run --project shared)
(cd vendor/kestrel && npx vitest run --project worker)
```

Kestrel's worker specs on the patched tree have two expected sets of failures (DESIGN.md, "The patch set"):
- the auth specs, which `0001-demo-auth` changes on purpose (401s, auth mode);
- the dev-badge specs in `test/archive.spec.ts`, which `0004-demo-chrome` changes.

Anything else failing there, notably a send, notification or fake-transport spec, is a real finding. Then run the demo with `npm run dev` and look:
- the dashboard loads a seeded sandbox;
- an archive page has its cover and the demo chrome;
- the editor shows the demo chrome and the "Demo sandbox" chip.

## 5. Open the draft PR

- **Title:** "Kestrel vX.Y.Z".
- **Body:**
  - the delta report;
  - each patch as applied cleanly, regenerated, or dropped;
  - shim and adapter changes;
  - what you checked by hand.
- **Issue:** a bump has no issue of its own unless you file one. File "Kestrel vX.Y.Z" in this repo first, so the PR can say `Closes #N` (`.claude/CLAUDE.md`).
- **On merge:** the deploy workflow ships it to production (when the repo variable `DEPLOY_ENABLED` is `true`), and every existing sandbox, seeded by the old release, is wiped and seeded fresh on its next request.
- **Then:** offer to bump getkestrel.dev's `.kestrel-docs-version` too (its `refresh-from-kestrel` skill), so the site's docs match the demo.
