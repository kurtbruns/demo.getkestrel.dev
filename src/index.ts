/**
 * The demo Worker (DESIGN.md, "Request flow"). Kestrel's admin tree is served from static
 * assets before this runs (wrangler.jsonc), the same bytes for every visitor. Everything
 * else is answered by the visitor's own sandbox, a Durable Object their session cookie
 * selects (src/session.ts), so a visitor can only ever see their own sandbox. A first
 * visit (a GET with no valid cookie) gets a new session, rate-limited per network, and a
 * redirect back to the same address: its sandbox starts only once the cookie comes back,
 * so a client that never returns cookies (a link preview, an image proxy, a scanner)
 * never starts one (DESIGN.md, "Session identity").
 */

// First, before Kestrel's modules evaluate: no request may leave the demo (src/egress.ts).
import "./egress-install";
import { BUILD_INFO } from "kestrel";
import { RESET_PATH } from "./sandbox_do";
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
 * The query parameter the first-visit redirect adds, so the Worker can tell a client that
 * followed it without returning the cookie (it never will) from one that hasn't been sent
 * yet, and stop rather than loop. It never reaches a sandbox: a request that carries it
 * with a valid cookie is sent back to the address without it.
 */
export const COOKIE_CHECK_PARAM = "demo-cookie";

/** What a client that doesn't return cookies gets: a person whose browser blocks them, or
 *  a link preview, image proxy or scanner, none of which needs a sandbox. */
const NEEDS_COOKIES = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Kestrel live demo</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem">
<h1 style="font-size: 1.4rem">Kestrel live demo</h1>
<p>Each visitor to the Kestrel demo gets a private sandbox of their own, which this browser's session cookie keeps track of. This browser didn't send the cookie back, so there's no sandbox to show.</p>
<p>Open <a href="/dashboard/">the demo</a> in a browser that allows cookies for demo.getkestrel.dev.</p>
</body></html>
`;

/** `url` with the cookie check added or removed, as a same-origin path. */
function withCookieCheck(url: URL, on: boolean): string {
  const out = new URL(url);
  if (on) {
    out.searchParams.set(COOKIE_CHECK_PARAM, "1");
  } else {
    out.searchParams.delete(COOKIE_CHECK_PARAM);
  }
  return out.pathname + out.search;
}

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
 * public pages and media `public`, but here every page is one visitor's own), its HTML is
 * always revalidated. A sandbox's response never carries a new cookie: the first-visit
 * redirect does, and is never stored.
 */
function privately(response: Response): Response {
  const out = new Response(response.body, response);
  if (out.headers.get("content-type")?.startsWith("text/html")) {
    // A sandbox's pages change under the visitor (an edit, a reset, the idle wipe), so the
    // browser revalidates them rather than showing a stale copy for Kestrel's 5 to 60
    // minutes.
    out.headers.set("cache-control", "private, no-cache");
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
  if (url.pathname === RESET_PATH && (request.method === "GET" || request.method === "HEAD")) {
    // The reset is a step in the dashboard's demo pill; an old link lands there. Answered
    // before the session, so following one starts no sandbox (the dashboard will).
    return new Response(null, {
      status: 303,
      headers: { location: "/dashboard/", "cache-control": "no-store" },
    });
  }

  const secret = (env as Env & Secrets).SESSION_SECRET;
  if (!secret) {
    // biome-ignore lint/suspicious/noConsole: the Worker's only log line for this misconfiguration.
    console.error("demo.config_invalid", "SESSION_SECRET is not set");
    return new Response("The demo is misconfigured: SESSION_SECRET is not set.", { status: 500 });
  }

  const token = await readSession(request, secret);
  const checking = url.searchParams.has(COOKIE_CHECK_PARAM);
  if (url.pathname === RESET_PATH && request.method === "POST") {
    if (!token) {
      // No sandbox to reset (an expired cookie, say): back to the editor, which starts one.
      return new Response(null, { status: 303, headers: { location: "/dashboard/" } });
    }
    // A reset costs as much as a new sandbox, so it shares the new-session limit.
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
  }
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
    if (checking) {
      // Sent a cookie a moment ago and didn't return it: no sandbox, and no new cookie.
      return new Response(NEEDS_COOKIES, {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
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
    // The new session's cookie, and the same address back. Its sandbox starts on the
    // request that returns the cookie, so a client that doesn't costs a signature, not a
    // migrate and a seed.
    const session = await mintSession(secret);
    const headers = new Headers({
      location: withCookieCheck(url, true),
      "cache-control": "no-store",
    });
    headers.append("set-cookie", sessionCookie(session.value));
    return new Response(null, { status: 303, headers });
  }
  if (checking && request.method === "GET") {
    // The cookie came back: on to the address the visitor asked for.
    return new Response(null, {
      status: 303,
      headers: { location: withCookieCheck(url, false), "cache-control": "no-store" },
    });
  }

  const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(secret, token)));
  let response: Response;
  try {
    response = await sandbox.fetch(request);
  } catch (err) {
    // The sandbox couldn't start (a migrate or seed that threw) or broke. Say so and log
    // it; the visitor keeps their cookie, so a reload retries the same sandbox.
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
  return privately(response);
}
