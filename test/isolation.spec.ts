// The safety property (DESIGN.md): a visitor can only ever see their own sandbox. Every
// request, public archive pages included, is answered by the sandbox their session cookie
// selects, so nobody can mint a demo URL that shows anyone else's content, and nothing the
// demo serves is indexed.
//
// Related tests elsewhere: an upload in one sandbox 404s in another at the same path, and a
// replaced or removed logo stays in its own sandbox (test/media.spec.ts); a forged or
// tampered cookie is a new session, not a way in (test/sessions.spec.ts).

import { runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/session";
import { BASE, exhaustNewSessions, publish, visitor } from "./support";

const MARKER = `isolation-${crypto.randomUUID()}`;

describe("a post published in one sandbox", () => {
  const a = visitor();
  const b = visitor();
  let slug = "";

  beforeAll(async () => {
    slug = await publish(a, {
      subject: `Only in A ${MARKER}`,
      slug: MARKER,
      markdown: `# Only in A\n\nThe body says ${MARKER}.`,
    });
    await b.fetch("/posts"); // B has a sandbox of its own
  });

  it("is on its own sandbox's public archive", async () => {
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

  it("is listed everywhere in its own sandbox, and nowhere in another", async () => {
    for (const path of [
      "/archive",
      "/archive/",
      "/",
      "/subscribe",
      "/posts",
      "/posts?status=sent",
    ]) {
      const own = await a.fetch(path);
      expect(own.status, `A ${path}`).toBe(200);
      const ownText = await own.text();
      const other = await b.fetch(path);
      expect(other.status, `B ${path}`).toBe(200);
      expect(await other.text(), `B ${path}`).not.toContain(MARKER);
      // A positive control, where the page lists posts at all: the absence in B means
      // something only if A's same page shows it.
      if (path !== "/subscribe") {
        expect(ownText, `A ${path}`).toContain(MARKER);
      }
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
    const [name, valueA] = (a.cookie ?? "").split("=");
    const [tokenA] = (valueA ?? "").split(".");
    const [, sigB] = ((b.cookie ?? "").split("=")[1] ?? "").split(".");
    // A's token unsigned, and A's token under B's real signature.
    for (const cookie of [`${name}=${tokenA}`, `${name}=${tokenA}.${sigB}`]) {
      const res = await SELF.fetch(`${BASE}/archive/${slug}`, {
        headers: { cookie, "cf-connecting-ip": "198.51.100.201" },
      });
      expect(res.status, cookie).toBe(404);
      expect(await res.text()).not.toContain(MARKER);
    }
  });

  it("has subscriber links that work only in their own sandbox", async () => {
    // A seeded subscriber's unsubscribe link, as A's emails carry it.
    const token = await runInDurableObject(await a.sandbox(), (_i, state) =>
      String(
        state.storage.sql
          .exec<{ unsub_token: string }>(
            "SELECT unsub_token FROM subscribers WHERE status = 'confirmed' LIMIT 1",
          )
          .one().unsub_token,
      ),
    );
    const own = await a.fetch(`/unsubscribe?token=${token}`);
    expect(own.status).toBe(200);
    await own.arrayBuffer();
    const other = await b.fetch(`/unsubscribe?token=${token}`);
    expect(other.status).toBe(400);
    await other.arrayBuffer();
  });
});

describe("noindex", () => {
  it("is on every response class the Worker makes", async () => {
    const v = visitor();
    const sent = await v.json<{ posts: { slug: string }[] }>("/posts?status=sent");
    const seededSlug = sent.body.posts[0]?.slug;
    expect(seededSlug).toBeDefined();
    const paths = [
      "/posts", // API JSON, from a sandbox
      `/archive/${seededSlug}`, // a public HTML page
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
