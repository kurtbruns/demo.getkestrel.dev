/**
 * The demo Worker (DESIGN.md, "Request flow"). Kestrel's admin tree is served from static
 * assets before this runs (wrangler.jsonc), the same bytes for every visitor. Everything
 * else is answered by the visitor's own sandbox, a Durable Object their session cookie
 * selects (src/session.ts), so a visitor can only ever see their own sandbox. A first
 * visit gets a new session, rate-limited per IP.
 */

import { BUILD_INFO } from "kestrel";
import { mintSession, readSession, sandboxName, sessionCookie } from "./session";

export { SandboxDO } from "./sandbox_do";

/** Bindings that aren't in wrangler.jsonc: secrets, set with `wrangler secret put` (or
 *  `.dev.vars` locally), so `wrangler types` doesn't always see them. */
interface Secrets {
  SESSION_SECRET?: string;
}

const ROBOTS = "User-agent: *\nDisallow: /\n";

/**
 * Paths that belong to Kestrel's static admin tree. Workers assets serve the files that
 * exist before this Worker runs; a request that reaches the Worker anyway is for a file
 * that doesn't exist, and answering it must not start a sandbox.
 */
function isAssetPath(pathname: string): boolean {
  return (
    pathname === "/dashboard" || pathname.startsWith("/dashboard/") || pathname === "/favicon.svg"
  );
}

/** The page a visitor sees when their IP has started too many sandboxes in the last minute. */
const TOO_MANY = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Kestrel demo: slow down a moment</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem">
<h1 style="font-size: 1.4rem">Too many new demos at once</h1>
<p>Each visit to the Kestrel demo gets its own private sandbox, and this network has started several in the last minute. Wait a minute and reload the page.</p>
<p>If you already have a demo open, keep using that tab: its sandbox is still there.</p>
</body></html>
`;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "kestrel-demo",
        kestrel: { version: BUILD_INFO.version, tag: BUILD_INFO.tag, sha: BUILD_INFO.sha },
      });
    }
    if (url.pathname === "/robots.txt") {
      return new Response(ROBOTS, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (isAssetPath(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    const secret = (env as Env & Secrets).SESSION_SECRET;
    if (!secret) {
      // biome-ignore lint/suspicious/noConsole: the Worker's only log line for this misconfiguration.
      console.error("demo.config_invalid", "SESSION_SECRET is not set");
      return new Response("The demo is misconfigured: SESSION_SECRET is not set.", { status: 500 });
    }

    let token = await readSession(request, secret);
    let newCookie: string | undefined;
    if (!token) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.NEW_SESSIONS.limit({ key: ip });
      if (!success) {
        return new Response(TOO_MANY, {
          status: 429,
          headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60" },
        });
      }
      const session = await mintSession(secret);
      token = session.token;
      newCookie = session.value;
    }

    const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(secret, token)));
    const response = await sandbox.fetch(request);
    if (!newCookie) {
      return response;
    }
    const withCookie = new Response(response.body, response);
    withCookie.headers.append("set-cookie", sessionCookie(newCookie));
    return withCookie;
  },
} satisfies ExportedHandler<Env>;
