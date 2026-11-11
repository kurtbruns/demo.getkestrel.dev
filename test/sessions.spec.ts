// Session routing (src/index.ts, src/session.ts): a cookie selects the visitor's own
// sandbox Durable Object, which migrates and seeds itself once; new sessions are
// rate-limited per IP; and paths that need no sandbox never start one.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rateLimitKey } from "../src/index";
import { COOKIE_CHECK_PARAM, mintSession, SESSION_COOKIE, sandboxName } from "../src/session";
import { BASE, exhaustNewSessions, SAME_ORIGIN, visitor } from "./support";

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

interface PostList {
  posts: { id: string; subject: string }[];
  page: { total: number };
}

/** How many times a sandbox's database has been seeded (src/sandbox.ts). */
async function seedCount(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM demo_meta WHERE key = 'seed_count'")
      .toArray()[0];
    return Number(row?.value ?? 0);
  });
}

/** Whether a sandbox has started: migrated and seeded, so its storage holds tables. */
async function started(stub: DurableObjectStub): Promise<boolean> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'demo_meta'")
      .one();
    return row.n > 0;
  });
}

/** The sandbox a `Set-Cookie` header's session selects. */
async function sandboxOf(setCookie: string | null): Promise<DurableObjectStub> {
  const token = (setCookie ?? "").slice(`${SESSION_COOKIE}=`.length).split(".")[0] ?? "";
  return env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(SECRET, token)));
}

describe("a first visit", () => {
  it("gets a signed cookie and a redirect back, and its sandbox starts once the cookie returns", async () => {
    const opts = { headers: { "cf-connecting-ip": "192.0.2.90" }, redirect: "manual" } as const;
    const first = await SELF.fetch(`${BASE}/api/posts?status=draft`, opts);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(
      `${BASE}/api/posts?status=draft&${COOKIE_CHECK_PARAM}=1`,
    );
    expect(first.headers.get("cache-control")).toBe("no-store");
    const set = first.headers.get("set-cookie") ?? "";
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43};`));
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(set).toContain(attr);
    }
    const sandbox = await sandboxOf(set);
    expect(await started(sandbox)).toBe(false);
    const cookie = set.split(";")[0] ?? "";
    // The cookie came back: on to the address asked for, still with no sandbox started.
    const back = await SELF.fetch(new URL(first.headers.get("location") ?? "", BASE), {
      headers: { ...opts.headers, cookie },
      redirect: "manual",
    });
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${BASE}/api/posts?status=draft`);
    expect(back.headers.get("set-cookie")).toBeNull();
    expect(await started(sandbox)).toBe(false);
    const res = await SELF.fetch(`${BASE}/api/posts?status=draft`, {
      headers: { ...opts.headers, cookie },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(await seedCount(sandbox)).toBe(1);
    expect(await started(sandbox)).toBe(true);
  });

  it("is answered by the visitor's new, seeded sandbox once the cookie check passes", async () => {
    const v = visitor();
    const res = await v.fetch("/api/posts");
    expect(res.status).toBe(200);
    expect(v.cookie).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$`),
    );
    const body = (await res.json()) as PostList;
    expect(body.page.total).toBeGreaterThanOrEqual(7);
    expect(body.posts.map((p) => p.subject)).toContain("Try editing this draft");
    expect(await seedCount(await v.sandbox())).toBe(1);
  });

  it("doesn't set a cookie on a later request with it", async () => {
    const v = visitor();
    await v.fetch("/api/posts");
    const again = await v.fetch("/api/posts");
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toBeNull();
  });
});

describe("a session", () => {
  it("reaches the same sandbox every time, and only its own", async () => {
    const a = visitor();
    const b = visitor();
    await a.fetch("/api/posts"); // a session starts with a GET, as the editor's does
    await b.fetch("/api/posts");
    const created = await a.fetch("/api/posts", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ subject: "Only in A's sandbox" }),
    });
    expect(created.status).toBe(201);
    const listed = await a.json<PostList>("/api/posts?status=draft");
    expect(listed.body.posts.map((p) => p.subject)).toContain("Only in A's sandbox");
    const other = await b.json<PostList>("/api/posts?status=draft");
    expect(other.body.posts.map((p) => p.subject)).not.toContain("Only in A's sandbox");
  });

  it("is seeded once, even under concurrent first requests", async () => {
    const { token, value } = await mintSession(SECRET);
    const cookie = `${SESSION_COOKIE}=${value}`;
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => SELF.fetch(`${BASE}/api/posts`, { headers: { cookie } })),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      const body = (await res.json()) as PostList;
      expect(body.page.total).toBeGreaterThanOrEqual(7);
    }
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(SECRET, token)));
    expect(await seedCount(stub)).toBe(1);
  });

  it("is seeded once when its first requests race within one event", async () => {
    // Separate requests are separate events, which blockConcurrencyWhile orders. These six
    // run inside one event, where only the shared start promise keeps them from each
    // starting a seed.
    const { token } = await mintSession(SECRET);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(SECRET, token)));
    const totals = await runInDurableObject(stub, async (instance) => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => instance.fetch(new Request(`${BASE}/api/posts`))),
      );
      return Promise.all(responses.map(async (r) => ((await r.json()) as PostList).page.total));
    });
    for (const total of totals) {
      expect(total).toBeGreaterThanOrEqual(7);
    }
    expect(await seedCount(stub)).toBe(1);
  });

  it("isn't honored when forged or tampered with: that's a new session", async () => {
    const real = visitor();
    await real.fetch("/api/posts");
    const [name, value] = (real.cookie ?? "").split("=");
    const [token, sig] = (value ?? "").split(".");
    const tampered = `${name}=${token}.${sig?.startsWith("A") ? "B" : "A"}${sig?.slice(1)}`;
    const forged = `${name}=${"a".repeat(43)}.${"b".repeat(43)}`;
    for (const cookie of [tampered, forged, `${name}=garbage`]) {
      const res = await SELF.fetch(`${BASE}/api/posts`, {
        headers: { cookie, "cf-connecting-ip": "192.0.2.77" },
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      const set = res.headers.get("set-cookie") ?? "";
      expect(set.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      expect(set).not.toContain(token);
    }
  });
});

describe("a client that doesn't return the cookie", () => {
  // A link preview, an image proxy, a scanner: each fetches an address once, with no cookie,
  // and never sends back the one it's given.
  it("gets one redirect and then a static page, and never starts a sandbox", async () => {
    const opts = { headers: { "cf-connecting-ip": "192.0.2.120" }, redirect: "manual" } as const;
    for (const path of [
      "/",
      "/archive/some-post",
      "/media/branding/logo/1794412141798-c3f39293",
      "/media/posts/5eed0002-0000-4000-8000-000000000002/kestrel.webp",
      "/.env",
      "/wp-login.php?redirect_to=x",
      "/api/posts",
    ]) {
      const first = await SELF.fetch(`${BASE}${path}`, opts);
      expect(first.status, path).toBe(303);
      const location = first.headers.get("location") ?? "";
      expect(location, path).toContain(`${COOKIE_CHECK_PARAM}=1`);
      const back = await SELF.fetch(new URL(location, BASE), opts);
      expect(back.status, path).toBe(403);
      expect(back.headers.get("set-cookie"), path).toBeNull();
      expect(back.headers.get("cache-control"), path).toBe("no-store");
      expect(back.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(await back.text(), path).toContain("didn't send the cookie back");
      expect(await started(await sandboxOf(first.headers.get("set-cookie"))), path).toBe(false);
    }
  });

  it("costs nothing when it arrives already carrying the cookie check", async () => {
    // A redirect target that was shared or crawled: no cookie, no new one, no rate limit.
    const ip = "192.0.2.121";
    for (let i = 0; i < 15; i++) {
      const res = await SELF.fetch(`${BASE}/?${COOKIE_CHECK_PARAM}=1`, {
        headers: { "cf-connecting-ip": ip },
        redirect: "manual",
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
      await res.arrayBuffer();
    }
    const { statuses } = await exhaustNewSessions(ip);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(303));
  });
});

describe("the cookie check", () => {
  it("is skipped by the dashboard's first call, which can't follow a redirect", async () => {
    // Kestrel's client probes /api/whoami with redirect: "manual" (client/auth.ts), so a
    // first load of /dashboard/, shared or after the cookie expired, must not get the 303.
    const own = {
      "cf-connecting-ip": "192.0.2.130",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    const res = await SELF.fetch(`${BASE}/api/whoami`, { headers: own, redirect: "manual" });
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie");
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    await res.arrayBuffer();
    expect(await started(await sandboxOf(set))).toBe(true);
    // A navigation, even same-origin, still gets the check: it can follow it.
    const nav = await SELF.fetch(`${BASE}/archive`, {
      headers: { ...own, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      redirect: "manual",
    });
    expect(nav.status).toBe(303);
    // So does a request from another site, or with no such headers at all.
    const cross = await SELF.fetch(`${BASE}/api/whoami`, {
      headers: { ...own, "sec-fetch-site": "cross-site" },
      redirect: "manual",
    });
    expect(cross.status).toBe(303);
  });

  it("only ever redirects to this origin", async () => {
    for (const path of ["//evil.example/x", "/\\evil.example/x", "///evil.example"]) {
      const first = await SELF.fetch(`${BASE}${path}`, {
        headers: { "cf-connecting-ip": "192.0.2.131" },
        redirect: "manual",
      });
      expect(first.status, path).toBe(303);
      const location = first.headers.get("location") ?? "";
      expect(new URL(location, BASE).origin, path).toBe(BASE);
      expect(location.startsWith(`${BASE}/`), path).toBe(true);
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const back = await SELF.fetch(location, {
        headers: { "cf-connecting-ip": "192.0.2.131", cookie },
        redirect: "manual",
      });
      expect(back.status, path).toBe(303);
      expect(new URL(back.headers.get("location") ?? "", BASE).origin, path).toBe(BASE);
    }
  });

  it("keeps the rest of the query exactly as sent", async () => {
    const opts = { headers: { "cf-connecting-ip": "192.0.2.132" }, redirect: "manual" } as const;
    const first = await SELF.fetch(`${BASE}/archive?a&b=%20x+y`, opts);
    expect(first.headers.get("location")).toBe(
      `${BASE}/archive?a&b=%20x+y&${COOKIE_CHECK_PARAM}=1`,
    );
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const back = await SELF.fetch(first.headers.get("location") ?? "", {
      headers: { ...opts.headers, cookie },
      redirect: "manual",
    });
    expect(back.headers.get("location")).toBe(`${BASE}/archive?a&b=%20x+y`);
    // Any value of the parameter, repeated or not, counts as the check and is removed whole.
    const odd = await SELF.fetch(
      `${BASE}/archive?${COOKIE_CHECK_PARAM}=0&a=1&${COOKIE_CHECK_PARAM}&${COOKIE_CHECK_PARAM}=x`,
      { ...opts, headers: { ...opts.headers, cookie } },
    );
    expect(odd.status).toBe(303);
    expect(odd.headers.get("location")).toBe(`${BASE}/archive?a=1`);
  });

  it("links a shared address that still carries it back to the address without it", async () => {
    // Someone shares the address their own cookie-blocking browser stopped on; the person
    // they share it with, whose browser keeps cookies, is one click from the page.
    const res = await SELF.fetch(`${BASE}/archive?x=1&${COOKIE_CHECK_PARAM}=1`, {
      headers: { "cf-connecting-ip": "192.0.2.133" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(`href="${BASE}/archive?x=1"`);
  });

  it("is removed from a request that isn't a GET before the sandbox sees it", async () => {
    const v = visitor("192.0.2.134");
    await v.fetch("/api/posts");
    const res = await v.fetch(`/?${COOKIE_CHECK_PARAM}=1`, { method: "HEAD" });
    expect(res.status).toBe(200);
  });
});

describe("the new-session rate limit", () => {
  it("answers 429 past the per-IP limit, without a cookie or a sandbox", async () => {
    const { statuses, refused } = await exhaustNewSessions("203.0.113.9");
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(303));
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("set-cookie")).toBeNull();
    expect(refused?.headers.get("content-type")).toContain("text/html");
    expect(await refused?.text()).toContain("Too many new demos");
  });

  it("doesn't count a returning visitor", async () => {
    const v = visitor("203.0.113.10");
    await v.fetch("/api/posts");
    for (let i = 0; i < 12; i++) {
      expect((await v.fetch("/api/whoami")).status).toBe(200);
    }
  });
});

describe("paths that need no sandbox", () => {
  it("never start a session", async () => {
    // In production Workers assets serve /dashboard/ before the Worker runs. The test pool
    // sends everything to the Worker, which answers an asset path it reaches with a 404 and
    // no session; either way, no sandbox starts.
    for (const path of [
      "/robots.txt",
      "/health",
      "/dashboard/",
      "/dashboard/missing.js",
      "/favicon.svg",
    ]) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status, path).toBe(
        path.startsWith("/dashboard") || path === "/favicon.svg" ? 404 : 200,
      );
      expect(res.headers.get("set-cookie"), path).toBeNull();
      await res.arrayBuffer();
    }
    const robots = await SELF.fetch(`${BASE}/robots.txt`);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  });
});

describe("hardening", () => {
  it("finds the valid cookie among several of the same name", async () => {
    const v = visitor();
    await v.fetch("/api/posts");
    const res = await SELF.fetch(`${BASE}/api/posts`, {
      headers: { cookie: `${SESSION_COOKIE}=junk; ${v.cookie}; ${SESSION_COOKIE}=more-junk` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.arrayBuffer();
  });

  it("starts no session for a cookieless write, HEAD or OPTIONS", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await SELF.fetch(`${BASE}/api/posts`, {
        method,
        headers: { "cf-connecting-ip": "198.51.100.150" },
      });
      expect(res.status, method).toBe(403);
      expect(res.headers.get("set-cookie"), method).toBeNull();
      expect(res.headers.get("x-robots-tag"), method).toBe("noindex");
      await res.arrayBuffer();
    }
  });

  it("answers Kestrel's MCP server only inside a session", async () => {
    // Since Kestrel 1.14.0, /api/mcp is a connector's door. A connector's servers carry no
    // demo cookie, so the Worker refuses them before any sandbox is chosen.
    const res = await SELF.fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://claude.ai",
        "cf-connecting-ip": "198.51.100.151",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("no_session");
  });

  it("starts no session for /favicon.ico", async () => {
    const res = await SELF.fetch(`${BASE}/favicon.ico`);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.arrayBuffer();
  });

  it("never lets a shared cache keep a sandbox's response", async () => {
    // The redirect that carries a new cookie is never stored.
    const first = await SELF.fetch(`${BASE}/`, {
      headers: { "cf-connecting-ip": "192.0.2.91" },
      redirect: "manual",
    });
    expect(first.status).toBe(303);
    expect(first.headers.get("set-cookie")).not.toBeNull();
    expect(first.headers.get("cache-control")).toBe("no-store");
    const v = visitor();
    // Kestrel marks its landing page `public, max-age=300`; in a sandbox it's private and
    // revalidated, so a reset or an edit shows at once.
    const again = await v.fetch("/");
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toMatch(/cookie/i);
    await again.arrayBuffer();
  });

  it("keys the rate limit on an IPv6 client's /64", () => {
    expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:0DB8:0001:0002::ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey(null)).toBe("unknown");
  });

  it("answers a 503 when the sandbox can't start, and recovers once it can", async () => {
    const { token, value } = await mintSession(SECRET);
    const name = await sandboxName(SECRET, token);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(name));
    // A migrations table the runner can't read makes the start throw.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("CREATE TABLE d1_migrations (unexpected INTEGER)");
    });
    const cookie = `${SESSION_COOKIE}=${value}`;
    const broken = await SELF.fetch(`${BASE}/api/posts`, { headers: { cookie } });
    expect(broken.status).toBe(503);
    expect(broken.headers.get("x-robots-tag")).toBe("noindex");
    expect(((await broken.json()) as { error: string }).error).toBe("sandbox_unavailable");
    // A start that throws inside blockConcurrencyWhile breaks the object, which the runtime
    // resets; a fresh stub reaches the new instance (over the same storage).
    const fix = (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS d1_migrations");
    };
    await runInDurableObject(stub, fix).catch(() =>
      runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(name)), fix),
    );
    const fixed = await SELF.fetch(`${BASE}/api/posts`, { headers: { cookie } });
    expect(fixed.status).toBe(200);
    await fixed.arrayBuffer();
  });
});
