import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// The Worker's suite (test/**/*.spec.ts), run inside workerd with the bindings from
// wrangler.jsonc, as Kestrel's own suite is. Each sandbox Durable Object migrates and seeds
// itself. The build script's tests (test/build) run under node:test instead
// (`npm run test:build`).
export default defineConfig(() => {
  return {
    resolve: {
      alias: { kestrel: fileURLToPath(new URL("./kestrel/entry.ts", import.meta.url)) },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // The session-signing secret (a Worker secret when deployed).
            SESSION_SECRET: "test-session-secret",
            // The production origin, so the suite runs Kestrel exactly as deployed: not
            // dev-shaped, so its dev auth and /api/dev/* routes are off.
            APP_ORIGIN: "https://demo.getkestrel.dev",
            // What a careless deploy might bind. The wrapper builds Kestrel's env from an
            // allowlist, so none of these may reach it (test/spike.spec.ts).
            DEV_AUTH_SECRET: "must-not-reach-kestrel",
            ACCESS_TEAM_DOMAIN: "must-not-reach-kestrel.cloudflareaccess.com",
            ACCESS_AUD: "must-not-reach-kestrel",
            PROVIDER: "ses",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.spec.ts"],
      exclude: [...configDefaults.exclude, "**/.claude/**", "vendor/**"],
    },
  };
});
