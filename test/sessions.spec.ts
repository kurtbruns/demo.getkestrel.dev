// Session routing (src/index.ts, src/session.ts): a cookie selects the visitor's own
// sandbox Durable Object, which migrates and seeds itself once; new sessions are
// rate-limited per IP; and paths that need no sandbox never start one.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rateLimitKey } from "../src/index";
import { mintSession, SESSION_COOKIE, sandboxName } from "../src/session";
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

describe("a first visit", () => {
  it("gets a signed session cookie and a seeded sandbox", async () => {
    const v = visitor();
    const res = await v.fetch("/posts");
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43};`));
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(set).toContain(attr);
    }
    const body = (await res.json()) as PostList;
    expect(body.page.total).toBeGreaterThanOrEqual(7);
    expect(body.posts.map((p) => p.subject)).toContain("Try editing this draft");
    expect(await seedCount(await v.sandbox())).toBe(1);
  });

  it("doesn't set a cookie on a later request with it", async () => {
    const v = visitor();
    await v.fetch("/posts");
    const again = await v.fetch("/posts");
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toBeNull();
  });
});

describe("a session", () => {
  it("reaches the same sandbox every time, and only its own", async () => {
    const a = visitor();
    const b = visitor();
    await a.fetch("/posts"); // a session starts with a GET, as the editor's does
    await b.fetch("/posts");
    const created = await a.fetch("/posts", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ subject: "Only in A's sandbox" }),
    });
    expect(created.status).toBe(201);
    const listed = await a.json<PostList>("/posts?status=draft");
    expect(listed.body.posts.map((p) => p.subject)).toContain("Only in A's sandbox");
    const other = await b.json<PostList>("/posts?status=draft");
    expect(other.body.posts.map((p) => p.subject)).not.toContain("Only in A's sandbox");
  });

  it("is seeded once, even under concurrent first requests", async () => {
    const { token, value } = await mintSession(SECRET);
    const cookie = `${SESSION_COOKIE}=${value}`;
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => SELF.fetch(`${BASE}/posts`, { headers: { cookie } })),
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
        Array.from({ length: 6 }, () => instance.fetch(new Request(`${BASE}/posts`))),
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
    await real.fetch("/posts");
    const [name, value] = (real.cookie ?? "").split("=");
    const [token, sig] = (value ?? "").split(".");
    const tampered = `${name}=${token}.${sig?.startsWith("A") ? "B" : "A"}${sig?.slice(1)}`;
    const forged = `${name}=${"a".repeat(43)}.${"b".repeat(43)}`;
    for (const cookie of [tampered, forged, `${name}=garbage`]) {
      const res = await SELF.fetch(`${BASE}/posts`, {
        headers: { cookie, "cf-connecting-ip": "192.0.2.77" },
      });
      expect(res.status).toBe(200);
      const set = res.headers.get("set-cookie") ?? "";
      expect(set.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      expect(set).not.toContain(token);
    }
  });
});

describe("the new-session rate limit", () => {
  it("answers 429 past the per-IP limit, without a cookie or a sandbox", async () => {
    const { statuses, refused } = await exhaustNewSessions("203.0.113.9");
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("set-cookie")).toBeNull();
    expect(refused?.headers.get("content-type")).toContain("text/html");
    expect(await refused?.text()).toContain("Too many new demos");
  });

  it("doesn't count a returning visitor", async () => {
    const v = visitor("203.0.113.10");
    await v.fetch("/posts");
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
    await v.fetch("/posts");
    const res = await SELF.fetch(`${BASE}/posts`, {
      headers: { cookie: `${SESSION_COOKIE}=junk; ${v.cookie}; ${SESSION_COOKIE}=more-junk` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.arrayBuffer();
  });

  it("starts no session for a cookieless write, HEAD or OPTIONS", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await SELF.fetch(`${BASE}/posts`, {
        method,
        headers: { "cf-connecting-ip": "198.51.100.150" },
      });
      expect(res.status, method).toBe(403);
      expect(res.headers.get("set-cookie"), method).toBeNull();
      await res.arrayBuffer();
    }
  });

  it("starts no session for /favicon.ico", async () => {
    const res = await SELF.fetch(`${BASE}/favicon.ico`);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.arrayBuffer();
  });

  it("never lets a shared cache keep a sandbox's response", async () => {
    const v = visitor();
    const first = await v.fetch("/");
    expect(first.headers.get("set-cookie")).not.toBeNull();
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("vary")).toMatch(/cookie/i);
    await first.arrayBuffer();
    // Kestrel marks its landing page `public, max-age=300`; in a sandbox it's private.
    const again = await v.fetch("/");
    expect(again.headers.get("cache-control")).toMatch(/^private\b/);
    expect(again.headers.get("cache-control")).not.toMatch(/public/);
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
      state.storage.sql.exec("CREATE TABLE demo_migrations (unexpected INTEGER)");
    });
    const cookie = `${SESSION_COOKIE}=${value}`;
    const broken = await SELF.fetch(`${BASE}/posts`, { headers: { cookie } });
    expect(broken.status).toBe(503);
    expect(((await broken.json()) as { error: string }).error).toBe("sandbox_unavailable");
    // A start that throws inside blockConcurrencyWhile breaks the object, which the runtime
    // resets; a fresh stub reaches the new instance (over the same storage).
    const fix = (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS demo_migrations");
    };
    await runInDurableObject(stub, fix).catch(() =>
      runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(name)), fix),
    );
    const fixed = await SELF.fetch(`${BASE}/posts`, { headers: { cookie } });
    expect(fixed.status).toBe(200);
    await fixed.arrayBuffer();
  });
});
