import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// The Worker's suite (test/**/*.spec.ts), run inside workerd with the bindings from
// wrangler.jsonc, as Kestrel's own suite is. Kestrel's migrations are read here (Node side)
// and applied per test file by test/setup.ts. The build script's tests (test/build) run
// under node:test instead (`npm run test:build`).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./vendor/kestrel/migrations");
  return {
    resolve: {
      alias: { kestrel: fileURLToPath(new URL("./kestrel/entry.ts", import.meta.url)) },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The production origin, so the suite runs Kestrel exactly as deployed: not
            // dev-shaped, so its dev auth and /api/dev/* routes are off.
            APP_ORIGIN: "https://demo.getkestrel.dev",
            // This spike shares one database, so it answers only local hosts; the suite
            // is let through explicitly (src/index.ts, until #4).
            SPIKE_SHARED_DB: "1",
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
      setupFiles: ["./test/setup.ts"],
      exclude: [...configDefaults.exclude, "**/.claude/**", "vendor/**"],
    },
  };
});
