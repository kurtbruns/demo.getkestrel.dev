/**
 * The demo Worker. For now only a liveness probe that names the Kestrel build it carries,
 * which also proves the wrapper can import from the pinned, patched tree in vendor/kestrel.
 * Kestrel's admin tree is served from static assets before this runs (wrangler.jsonc).
 */

import { BUILD_INFO } from "../vendor/kestrel/src/generated/version";

export default {
  fetch(request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "kestrel-demo",
        kestrel: { version: BUILD_INFO.version, tag: BUILD_INFO.tag, sha: BUILD_INFO.sha },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
