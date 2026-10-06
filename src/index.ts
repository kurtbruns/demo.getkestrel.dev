/**
 * The demo Worker: Kestrel at the pinned, patched release (see DESIGN.md), run on the
 * sandbox env from sandbox.ts. Kestrel's admin tree is served from static assets before
 * this runs (wrangler.jsonc). For now every visitor shares the Worker's own D1 and R2;
 * #4 gives each visitor a Durable Object of their own.
 */

import kestrel, { BUILD_INFO } from "kestrel";
import { ensureSeeded, sandboxEnv } from "./sandbox";

// One seed check per isolate, shared by concurrent first requests.
let seeding: Promise<void> | undefined;

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
    const senv = sandboxEnv(env);
    seeding ??= ensureSeeded(senv, BUILD_INFO.tag).catch((err: unknown) => {
      seeding = undefined; // let the next request retry
      throw err;
    });
    await seeding;
    return kestrel.fetch(request, senv, ctx);
  },
} satisfies ExportedHandler<Env>;
