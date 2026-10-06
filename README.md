# demo.getkestrel.dev

A per-visitor sandboxed live demo of [Kestrel](https://github.com/kurtbruns/kestrel), served at demo.getkestrel.dev.

The demo runs Kestrel at the release pinned in `.kestrel-version`, plus a small patch set in `patches/`, inside a thin Cloudflare Worker. `DESIGN.md` explains the architecture and the safety property, and the [milestone](https://github.com/kurtbruns/demo.getkestrel.dev/milestone/1) tracks the build-out.

## Develop

Needs Node 22 or later and git.

```bash
npm ci
npm run build    # clone Kestrel at .kestrel-version into vendor/, apply patches/, build it
npm run dev      # wrangler dev (rebuilds vendor/ only when the pin or a patch changed)
npm run check    # wrangler types, tsc, Biome
npm test         # the build script's patch-mechanism tests
```

`npm run build -- --force` rebuilds `vendor/` from scratch. `patches/README.md` explains how to write a patch.
