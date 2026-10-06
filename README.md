# demo.getkestrel.dev

A per-visitor sandboxed live demo of [Kestrel](https://github.com/kurtbruns/kestrel), served at demo.getkestrel.dev.

The demo runs Kestrel at the release pinned in `.kestrel-version`, plus a small patch set in `patches/`, inside a thin Cloudflare Worker. `DESIGN.md` explains the architecture and the safety property, and the [milestone](https://github.com/kurtbruns/demo.getkestrel.dev/milestone/1) tracks the build-out.

## Develop

Needs Node 22 or later and git.

```bash
npm ci
npm run build          # clone Kestrel at .kestrel-version into vendor/, apply patches/, build it
npm run migrate:local  # apply Kestrel's migrations to the local D1 (once, and after a Kestrel bump)
npm run dev            # wrangler dev on http://localhost:8788; the editor is at /dashboard/
npm run check          # wrangler types, tsc, Biome
npm test               # the Worker suite (Vitest in workerd), then the build script's tests
```

The first request seeds the "Field Notes" demo publication with Kestrel's own seed.

`npm run build -- --force` rebuilds `vendor/` from scratch. `patches/README.md` explains how to write a patch.

`package.json`'s `allowScripts` lists, at exact versions, the dependencies whose install scripts npm 12 may run (esbuild and workerd, through wrangler). After bumping wrangler, run `npm install-scripts ls` and approve the new versions, or npm 12 silently skips their install scripts.
