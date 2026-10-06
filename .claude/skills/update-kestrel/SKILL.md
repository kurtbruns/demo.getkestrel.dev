---
name: update-kestrel
description: >-
  Move the live demo to a new Kestrel release: bump .kestrel-version, carry the patch set
  across, check what the release changed against the wrapper, and open a draft PR. Use it
  whenever Kestrel cuts a tag and the demo should follow ("update the demo to kestrel
  v1.3.0", "kestrel released, bump the pin", "advance .kestrel-version"), and any time you
  edit .kestrel-version by hand. The bump is one line; regenerating patches, keeping the
  `kestrel` module shim honest and catching new D1 usage is the point.
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

- **A patch that fails to apply** stops the build and names it. Regenerate it against the new tag with the recipe in `patches/README.md`, keeping its header and intent. Run `--apply-only` with only the patches before it in `patches/`, commit inside the clone, `git apply` the old patch with `--3way` or by hand, then edit and diff.
- **A patch whose change the release now makes itself:** drop it, and remove its row from `DESIGN.md`'s patch table.
- **A patch that applies but whose files changed** (the report's last column): reread it against the new code. Applying cleanly isn't the same as still being right.

## 3. Keep the wrapper's view of Kestrel honest

`tsc` checks the wrapper only against the hand-written `src/types/kestrel.d.ts`, so a signature change in Kestrel passes `npm run check`. For every file the report lists under "What the wrapper imports or relies on", compare what `kestrel/entry.ts` re-exports with the shim, and update the shim to match. Then:
- **New D1 API flagged:** extend `src/d1/adapter.ts` and its tests (`test/d1-adapter.spec.ts`).
- **New migrations:** nothing to do. `test/d1-adapter.spec.ts` checks every table, index and added column they declare.
- **Wrangler changes:** if Kestrel's compatibility date, flags or module rules changed, mirror them in this repo's `wrangler.jsonc`.

## 4. Check

```bash
npm run check && npm test
(cd vendor/kestrel && npm run typecheck && npx vitest run --project client)
(cd vendor/kestrel && node scripts/check-css-tokens.mjs)
```

Kestrel's own worker specs on the patched tree are expected to fail where `0001-demo-auth` changes auth on purpose (401s, auth mode). Its fake-transport and send specs should pass. Then run the demo with `npm run dev` and look:
- the dashboard loads a seeded sandbox;
- an archive page has its cover and the demo strip;
- the "Demo sandbox" chip and the editor's banner show.

## 5. Open the draft PR

- **Title:** "Kestrel vX.Y.Z".
- **Body:**
  - the delta report;
  - each patch as applied cleanly, regenerated, or dropped;
  - shim and adapter changes;
  - what you checked by hand.
- **On merge:** the deploy workflow ships it, and every existing sandbox, seeded by the old release, is wiped and seeded fresh on its next request.
- **Then:** offer to bump getkestrel.dev's `.kestrel-docs-version` too (its `refresh-from-kestrel` skill), so the site's docs match the demo.
