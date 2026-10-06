/**
 * What the demo hands Kestrel: the sandbox env, and the first-use seed. #4 moves both into
 * the per-visitor Durable Object; until then they run against the Worker's own D1 and R2.
 */

import { demoImages, demoLogo, getConfig, type KestrelEnv, seedDatabase } from "kestrel";

/**
 * The env Kestrel runs on. Built from an allowlist, never by spreading the Worker's env, so
 * nothing the deploy happens to bind (a `DEV_AUTH_SECRET`, Access settings, a `NOTIFY`
 * binding, a provider or its credentials) can reach Kestrel. The transport is always the
 * fake.
 */
export function sandboxEnv(env: Pick<Env, "DB" | "MEDIA" | "APP_ORIGIN">): KestrelEnv {
  return {
    DB: env.DB,
    MEDIA: env.MEDIA,
    PROVIDER: "fake",
    APP_ORIGIN: env.APP_ORIGIN,
    ARCHIVE_BASE_PATH: "/archive",
    // Required by Kestrel's Env and unused by the fake transport; .example can't route mail.
    SENDING_DOMAIN: "send.field-notes.example",
    FROM_ADDRESS: "Field Notes <newsletter@send.field-notes.example>",
    AWS_REGION: "us-east-1",
    // Kestrel's floor: a demo send fires within a visit.
    MIN_LEAD_SECONDS: "60",
  };
}

const MARKER = "seeded_kestrel";

/**
 * Load the "Field Notes" demo with Kestrel's own seed, once per database and Kestrel
 * version. The marker table is the demo's, not Kestrel's: the seed's `resetAll` clears only
 * Kestrel's tables, so the marker survives it. A database seeded by another Kestrel version
 * is seeded again, which resets it (DESIGN.md, "Updating the demo"). Returns whether it
 * seeded.
 */
export async function ensureSeeded(env: KestrelEnv, version: string): Promise<boolean> {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  ).run();
  const seeded = await env.DB.prepare("SELECT value FROM demo_meta WHERE key = ?")
    .bind(MARKER)
    .first<string>("value");
  if (seeded === version) {
    return false;
  }
  await seedDatabase(env, getConfig(env), demoImages, demoLogo);
  await env.DB.prepare("INSERT OR REPLACE INTO demo_meta (key, value) VALUES (?, ?)")
    .bind(MARKER, version)
    .run();
  return true;
}
