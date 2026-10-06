/**
 * The demo Worker (DESIGN.md, "Request flow"). Kestrel's admin tree is served from static
 * assets before this runs (wrangler.jsonc), the same bytes for every visitor. Everything
 * else is answered by the visitor's own sandbox, a Durable Object their session cookie
 * selects (src/session.ts), so a visitor can only ever see their own sandbox. A first
 * visit (a GET with no valid cookie) gets a new session, rate-limited per network.
 */

// First, before Kestrel's modules evaluate: no request may leave the demo (src/egress.ts).
import "./egress-install";
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
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/favicon.svg" ||
    // Browsers ask for this on their own; Kestrel has none, and it mustn't start a sandbox.
    pathname === "/favicon.ico"
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

/**
 * The rate limit's key: the client's IPv4 address, or its IPv6 /64. One IPv6 client usually
 * holds a whole /64 and can rotate addresses within it, so keying on the full address would
 * be no limit at all. Cloudflare always sets `cf-connecting-ip` in production.
 */
export function rateLimitKey(ip: string | null): string {
  if (!ip) {
    return "unknown";
  }
  if (!ip.includes(":")) {
    return ip;
  }
  // Expand "::" so the first four groups are the /64, whatever the address's shorthand.
  const [left = "", right] = ip.toLowerCase().split("::");
  const head = left ? left.split(":") : [];
  const tail = right === undefined ? [] : right ? right.split(":") : [];
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * A sandbox's response, made safe to send: no shared cache may keep it (Kestrel marks its
 * public pages and media `public`, but here every page is one visitor's own), and a response
 * that starts a session is never stored at all, since it carries the cookie.
 */
function privately(response: Response, newCookie: string | undefined): Response {
  const out = new Response(response.body, response);
  if (newCookie) {
    out.headers.set("cache-control", "private, no-store");
    out.headers.append("set-cookie", sessionCookie(newCookie));
  } else {
    // Kestrel's errors carry no cache header at all; those are private too.
    const cc = out.headers.get("cache-control");
    out.headers.set("cache-control", cc ? cc.replace(/\bpublic\b/i, "private") : "private");
  }
  if (!/\bcookie\b/i.test(out.headers.get("vary") ?? "")) {
    out.headers.append("vary", "Cookie");
  }
  return out;
}

export default {
  /**
   * Every response the Worker makes, sandbox pages and errors alike, says not to index it
   * (DESIGN.md, "The safety property"). Static assets get the same from Kestrel's _headers
   * (patches/0003-demo-noindex.patch), since they're served before the Worker runs.
   */
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      // Anything the Worker itself didn't expect (a binding outage, say) still gets an
      // answer of its own, so it carries the headers below rather than the platform's page.
      // biome-ignore lint/suspicious/noConsole: the Worker's only log line for this.
      console.error("demo.worker_error", err);
      response = new Response("The demo hit an error. Reload the page to try again.", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const out = new Response(response.body, response);
    out.headers.set("x-robots-tag", "noindex");
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
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
    // Only a GET starts a session. The editor's first requests are GETs; a cookieless
    // write is another site's form posting here (a SameSite=Lax cookie isn't sent on a
    // cross-site POST), and starting a session for it would replace the visitor's own.
    // A HEAD or OPTIONS, from a monitor or a preflight, has no use for a sandbox either.
    if (request.method !== "GET") {
      return Response.json(
        { error: "no_session", message: "open the demo in a browser first" },
        { status: 403 },
      );
    }
    const { success } = await env.NEW_SESSIONS.limit({
      key: rateLimitKey(request.headers.get("cf-connecting-ip")),
    });
    if (!success) {
      return new Response(TOO_MANY, {
        status: 429,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "retry-after": "60",
          "cache-control": "no-store",
        },
      });
    }
    const session = await mintSession(secret);
    token = session.token;
    newCookie = session.value;
  }

  const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(secret, token)));
  let response: Response;
  try {
    response = await sandbox.fetch(request);
  } catch (err) {
    // The sandbox couldn't start (a migrate or seed that threw) or broke. Say so, log it,
    // and still hand over a new session's cookie, so a reload retries the same sandbox
    // rather than starting another.
    // biome-ignore lint/suspicious/noConsole: the Worker's only log line for a broken sandbox.
    console.error("demo.sandbox_failed", err);
    response = Response.json(
      {
        error: "sandbox_unavailable",
        message: "Your demo sandbox couldn't start. Reload the page to try again.",
      },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
  return privately(response, newCookie);
}
