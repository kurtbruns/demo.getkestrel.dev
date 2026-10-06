/**
 * What the demo hands Kestrel inside a visitor's sandbox: the env it runs on, and the
 * first-use seed (DESIGN.md, "Request flow").
 */

import { demoImages, demoLogo, getConfig, type KestrelEnv, seedDatabase } from "kestrel";

/**
 * The env Kestrel runs on, over the sandbox's own database and media. Built from an allowlist, never by spreading the Worker's env, so
 * nothing the deploy happens to bind (a `DEV_AUTH_SECRET`, Access settings, a `NOTIFY`
 * binding, a provider or its credentials) can reach Kestrel. The transport is always the
 * fake.
 */
export function sandboxEnv(
  env: Pick<Env, "APP_ORIGIN">,
  db: D1Database,
  media: R2Bucket,
): KestrelEnv {
  return {
    DB: db,
    MEDIA: media,
    PROVIDER: "fake",
    APP_ORIGIN: env.APP_ORIGIN,
    ARCHIVE_BASE_PATH: "/archive",
    // Required by Kestrel's Env and unused by the fake transport; .example can't route mail.
    SENDING_DOMAIN: "send.field-notes.example",
    FROM_ADDRESS: "Field Notes <newsletter@send.field-notes.example>",
    AWS_REGION: "us-east-1",
    // Kestrel's floor: a demo send fires within a visit.
    MIN_LEAD_SECONDS: "60",
    // Kestrel's cap. Its default (50) is Workers Free's subrequest limit, but the adapter's
    // statements are local SQLite calls, not subrequests, so a send finishes in one tick.
    SUBREQUEST_BUDGET: "1000",
  };
}

/**
 * Refuse to run Kestrel on anything but the fake transport, whatever `sandboxEnv` builds:
 * a belt to the allowlist's braces. Kestrel resolves its notification channel from the env
 * too, and it must not be Cloudflare's own email.
 */
export function checkSandboxConfig(env: KestrelEnv): void {
  const config = getConfig(env);
  if (config.provider !== "fake" || config.notifyChannel === "cloudflare") {
    throw new Error(
      `the demo sandbox runs only on the fake transport (provider ${config.provider}, notifications ${config.notifyChannel})`,
    );
  }
}

const MARKER = "seeded_kestrel";

/**
 * Load the "Field Notes" demo with Kestrel's own seed, once per database and Kestrel
 * version. The marker table is the demo's, not Kestrel's: the seed's `resetAll` clears only
 * Kestrel's tables, so the marker survives it. A database seeded by another Kestrel version
 * is seeded again, which resets it (DESIGN.md, "Updating the demo"). `beforeSeed` runs
 * only when it is about to seed, for what Kestrel's `resetAll` can't reach (the sandbox's
 * own uploads). `env.MEDIA` should be the seed's view of the sandbox's media
 * (`SandboxMedia.seedView`). Returns whether it seeded.
 */
export async function ensureSeeded(
  env: KestrelEnv,
  version: string,
  beforeSeed?: () => Promise<void>,
): Promise<boolean> {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  ).run();
  const seeded = await env.DB.prepare("SELECT value FROM demo_meta WHERE key = ?")
    .bind(MARKER)
    .first<string>("value");
  if (seeded === version) {
    return false;
  }
  await beforeSeed?.();
  await seedDatabase(env, getConfig(env), demoImages, demoLogo);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO demo_meta (key, value) VALUES (?, ?)").bind(
      MARKER,
      version,
    ),
    // How many times this database has been seeded, for the tests and for operating the
    // demo: a sandbox should be seeded once per Kestrel version, or again after a reset.
    env.DB.prepare(
      `INSERT INTO demo_meta (key, value) VALUES ('seed_count', '1')
       ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    ),
  ]);
  return true;
}
