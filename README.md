# demo.getkestrel.dev

A per-visitor sandboxed live demo of [Kestrel](https://github.com/kurtbruns/kestrel), served at demo.getkestrel.dev.

The demo runs Kestrel at the release pinned in `.kestrel-version`, plus a small patch set in `patches/`, inside a thin Cloudflare Worker. `DESIGN.md` explains the architecture and the safety property, and the [milestone](https://github.com/kurtbruns/demo.getkestrel.dev/milestone/1) tracks the build-out.

## Develop

Needs Node 22 or later and git.

```bash
npm ci
cp .dev.vars.example .dev.vars   # the local SESSION_SECRET
npm run build          # clone Kestrel at .kestrel-version into vendor/, apply patches/, build it
npm run dev            # wrangler dev on http://localhost:8788; the editor is at /dashboard/
npm run check          # wrangler types, tsc, Biome
npm test               # the Worker suite (Vitest in workerd), then the build script's tests
```

Each visitor (each session cookie) gets a sandbox of their own, which migrates and seeds the "Field Notes" demo publication on its first request. To see two independent sandboxes, use two browser profiles, or a private window.

`npm run build -- --force` rebuilds `vendor/` from scratch. `patches/README.md` explains how to write a patch.

`package.json`'s `allowScripts` lists, at exact versions, the dependencies whose install scripts npm 12 may run (esbuild and workerd, through wrangler). After bumping wrangler, run `npm install-scripts ls` and approve the new versions, or npm 12 silently skips their install scripts.

## Deploy

Production is the `production` env in `wrangler.jsonc`: the `kestrel-demo` Worker, served only at demo.getkestrel.dev. `.github/workflows/deploy.yml` deploys it on every push to `main` (and on demand from `main`), after the same build, check and tests as CI, but only once the repo variable `DEPLOY_ENABLED` is `true`. Deploy by hand with `npm run deploy`. A bare `wrangler deploy` deploys the development config to a separate Worker, `kestrel-demo-dev`, and never touches production.

One-time setup, in this order:

1. **R2 bucket.** `npx wrangler r2 bucket create kestrel-demo-media`, in the Cloudflare account that holds the getkestrel.dev zone.
2. **API token.** In the Cloudflare dashboard, create a token from the "Edit Cloudflare Workers" template, limited to that account and the getkestrel.dev zone, and add **Zone → DNS → Edit** for getkestrel.dev, which the template lacks and the Custom Domain needs (getkestrel.dev's own token has it). The template already covers Workers Scripts, Workers Routes and R2.
3. **GitHub secrets.** In this repo's Settings → Environments, create (or open) `production`, add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID`, and restrict its deployment branches to `main`.
4. **Enable and deploy.** Set the repo variable `DEPLOY_ENABLED` to `true` (Settings → Secrets and variables → Actions → Variables), then run the Deploy workflow (Actions → Deploy → Run workflow). The first deploy creates the `kestrel-demo` Worker, and the Custom Domain creates the `demo.getkestrel.dev` DNS record and certificate in the getkestrel.dev zone. **Don't create a DNS record for demo.getkestrel.dev yourself:** a deploy from CI replaces an existing one without asking.
5. **Session secret.** `npx wrangler secret put SESSION_SECRET --env production`, with a long random value (`openssl rand -base64 48`). Until it's set, the Worker answers every sandbox request with a 500 saying so. Changing it later signs every visitor out of their sandbox.
6. **Check it.** `https://demo.getkestrel.dev/dashboard/` loads a seeded sandbox, a private window gets a separate one, and `curl -sI https://demo.getkestrel.dev/` shows `x-robots-tag: noindex`.
