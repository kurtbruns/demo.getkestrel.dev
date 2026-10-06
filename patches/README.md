# Patches

Small `git` patches applied, in filename order, to Kestrel at the tag in `.kestrel-version` after `scripts/fetch-kestrel.mjs` clones it into `vendor/kestrel`. They are how the demo gets Kestrel to behave differently without changing Kestrel itself. `DESIGN.md` ("The patch set") lists them and says why, and `.claude/CLAUDE.md` ("Patches") has the rules.

To write or update one:

```bash
node scripts/fetch-kestrel.mjs --apply-only
```

That clones the pinned tag and applies the existing patches, then stops. Commit that state inside the clone, so your diff holds only the new change:

```bash
git -C vendor/kestrel add -A && git -C vendor/kestrel commit -qm "existing patches"
```

Edit `vendor/kestrel`, then write the change out with `git -C vendor/kestrel diff > patches/NNNN-name.patch`. Put a header comment above the first `diff --git` line: what it changes, why the demo needs it, and the issue. Then run `node scripts/fetch-kestrel.mjs --force` to prove the whole set applies and builds from clean. To revise an existing patch, move it out of `patches/` first, run `--apply-only` and commit, then `git -C vendor/kestrel apply` the old patch, edit, and diff again.
