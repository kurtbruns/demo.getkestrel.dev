# Patches

Small `git` patches applied, in filename order, to Kestrel at the tag in `.kestrel-version` after `scripts/fetch-kestrel.mjs` clones it into `vendor/kestrel`. They are how the demo gets Kestrel to behave differently without changing Kestrel itself. `DESIGN.md` ("The patch set") lists them and says why, and `.claude/CLAUDE.md` ("Patches") has the rules.

To write or update one:

```bash
node scripts/fetch-kestrel.mjs --apply-only
```

That clones the pinned tag, applies the existing patches, and stops. It also leaves a marker (`vendor/.kestrel-authoring`) that makes every other build refuse to run, so a running `npm run dev` or `npm run check` can't reclone over your edits. Commit that state inside the clone, so your diff holds only the new change:

```bash
git -C vendor/kestrel add -A && git -C vendor/kestrel commit -qm "existing patches" --allow-empty
```

Edit `vendor/kestrel`, then stage everything and write the staged diff, which includes any new files:

```bash
git -C vendor/kestrel add -A && git -C vendor/kestrel diff --cached > /tmp/NNNN-name.patch
```

Write it outside `patches/` first, then move it in, because `wrangler dev` watches that directory. Put a header comment above the first `diff --git` line: what it changes, why the demo needs it, and the issue. Then run `node scripts/fetch-kestrel.mjs --force`, which clears the marker and proves the whole set applies and builds from clean. To revise an existing patch, move it (and every patch after it) out of `patches/` first, run `--apply-only` and commit, then `git -C vendor/kestrel apply` the old patch, edit, and write the diff again. After a version bump, when the old patch no longer applies, fetch the old tag into the clone first (`git -C vendor/kestrel fetch --depth 1 origin tag <old tag>`), since the build's clone is shallow, and apply with `--3way`. The `update-kestrel` skill walks through it.
