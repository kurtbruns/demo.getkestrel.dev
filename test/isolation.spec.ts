// The safety property (DESIGN.md): a visitor can only ever see their own sandbox. Every
// request, public archive pages included, is answered by the sandbox their session cookie
// selects, so nobody can mint a demo URL that shows anyone else's content, and nothing the
// demo serves is indexed.
//
// Related tests elsewhere: an upload in one sandbox 404s in another at the same path, and a
// replaced or removed logo stays in its own sandbox (test/media.spec.ts); a forged or
// tampered cookie is a new session, not a way in (test/sessions.spec.ts).

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/session";
import { BASE, exhaustNewSessions, publish, visitor } from "./support";

const MARKER = `isolation-${crypto.randomUUID()}`;

describe("a post published in one sandbox", () => {
  const a = visitor();
  const b = visitor();
  let slug = "";

  it("is on its own sandbox's public archive", async () => {
    slug = await publish(a, {
      subject: `Only in A ${MARKER}`,
      slug: MARKER,
      markdown: `# Only in A\n\nThe body says ${MARKER}.`,
    });
    expect(slug).toBe(MARKER);
    const page = await a.fetch(`/archive/${slug}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(MARKER);
  });

  it("404s at the same URL in another sandbox", async () => {
    const page = await b.fetch(`/archive/${slug}`);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain(MARKER);
  });

  it("is in neither the other sandbox's archive index nor its post list", async () => {
    for (const path of ["/archive", "/archive/", "/", "/posts", "/posts?status=sent"]) {
      const res = await b.fetch(path);
      expect(await res.text(), path).not.toContain(MARKER);
    }
  });

  it("404s for a visitor with no cookie, who gets a fresh sandbox of their own", async () => {
    const res = await SELF.fetch(`${BASE}/archive/${slug}`, {
      headers: { "cf-connecting-ip": "198.51.100.200" },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(MARKER);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });

  it("can't be reached with a cookie that only resembles A's", async () => {
    const [name, value] = (a.cookie ?? "").split("=");
    const [token] = (value ?? "").split(".");
    for (const cookie of [`${name}=${token}`, `${name}=${token}.${"A".repeat(43)}`]) {
      const res = await SELF.fetch(`${BASE}/archive/${slug}`, {
        headers: { cookie, "cf-connecting-ip": "198.51.100.201" },
      });
      expect(res.status, cookie).toBe(404);
      expect(await res.text()).not.toContain(MARKER);
    }
  });
});

describe("noindex", () => {
  it("is on every response class the Worker makes", async () => {
    const v = visitor();
    const sent = await v.json<{ posts: { slug: string }[] }>("/posts?status=sent");
    const paths = [
      "/posts", // API JSON, from a sandbox
      `/archive/${sent.body.posts[0]?.slug}`, // a public HTML page
      "/media/posts/5eed0001-0000-4000-8000-000000000001/kestrel.webp", // media
      "/no-such-page", // Kestrel's 404
      "/dashboard/missing.js", // the Worker's own 404 for an asset path
      "/health",
      "/robots.txt",
    ];
    for (const path of paths) {
      const res = await v.fetch(path);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      await res.arrayBuffer();
    }
  });

  it("is on the 429 page", async () => {
    const { refused } = await exhaustNewSessions("203.0.113.50");
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("x-robots-tag")).toBe("noindex");
    await refused?.arrayBuffer();
  });
});
