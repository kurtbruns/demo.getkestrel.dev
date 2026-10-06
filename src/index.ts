/**
 * The demo Worker: Kestrel at the pinned, patched release (see DESIGN.md), run on the
 * sandbox env from sandbox.ts. Kestrel's admin tree is served from static assets before
 * this runs (wrangler.jsonc). For now every visitor shares the Worker's own D1 and R2;
 * #4 gives each visitor a Durable Object of their own.
 */

import kestrel, { BUILD_INFO } from "kestrel";
import { ensureSeeded, sandboxEnv } from "./sandbox";

/**
 * The seed check, at most one in flight per database. Keyed by the database, not held in
 * one module-level promise: Durable Objects of one class share an isolate, so a single
 * latch would let one visitor's finished seed stand in for every other visitor's (#4).
 */
const seeding = new WeakMap<D1Database, Promise<boolean>>();

function seedOnce(db: D1Database, run: () => Promise<boolean>): Promise<boolean> {
  let pending = seeding.get(db);
  if (!pending) {
    pending = run().finally(() => seeding.delete(db));
    seeding.set(db, pending);
  }
  return pending;
}

/** Hosts this shared-database spike may answer: local dev, and the test suite. */
function spikeAllowed(url: URL, env: Env & { SPIKE_SHARED_DB?: string }): boolean {
  return ["localhost", "127.0.0.1"].includes(url.hostname) || env.SPIKE_SHARED_DB === "1";
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "kestrel-demo",
        kestrel: { version: BUILD_INFO.version, tag: BUILD_INFO.tag, sha: BUILD_INFO.sha },
      });
    }
    // Until #4, every visitor would share one database and one open admin, which breaks
    // the safety property (DESIGN.md), so this never serves a public host.
    if (!spikeAllowed(url, env)) {
      return new Response("The demo isn't open yet.", { status: 503 });
    }
    const senv = sandboxEnv(env);
    try {
      await seedOnce(senv.DB, () => ensureSeeded(senv, BUILD_INFO.tag));
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: the Worker's only log line for a failed seed.
      console.error("demo.seed_failed", err);
      return Response.json(
        {
          error: "seed_failed",
          message: `Couldn't load the demo publication: ${err instanceof Error ? err.message : String(err)}. Locally, has \`npm run migrate:local\` run?`,
        },
        { status: 503 },
      );
    }
    return kestrel.fetch(request, senv, ctx);
  },
} satisfies ExportedHandler<Env>;
