// The safety property (DESIGN.md): a visitor can only ever see their own sandbox. Every
// request, public archive pages included, is answered by the sandbox their session cookie
// selects, so nobody can mint a demo URL that shows anyone else's content, and nothing the
// demo serves is indexed.
//
// A list imported in one sandbox (since Kestrel v1.9.0) is likewise absent from another's
// export and subscriber list, and a block or an erasure (since v1.10.0) suppresses the
// address in its own sandbox only. An email-only post's unlisted link (since v1.12.0) is
// likewise its own sandbox's page and nothing in another.
//
// Related tests elsewhere: an upload in one sandbox 404s in another at the same path, and a
// replaced or removed logo stays in its own sandbox (test/media.spec.ts); a forged or
// tampered cookie is a new session, not a way in (test/sessions.spec.ts).

import { runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/session";
import {
  BASE,
  exhaustNewSessions,
  exportList,
  importList,
  NO_BODY,
  publish,
  SAME_ORIGIN,
  type Visitor,
  visitor,
} from "./support";

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
    await b.fetch("/api/posts"); // B has a sandbox of its own
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
      "/api/posts",
      "/api/posts?status=sent",
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

describe("an email-only post's unlisted link", () => {
  const a = visitor();
  const b = visitor();
  const marker = `${MARKER}-unlisted`;
  let token = "";

  beforeAll(async () => {
    const slug = await publish(a, {
      subject: `Email only in A ${marker}`,
      slug: marker,
      markdown: `# Email only in A\n\nThe body says ${marker}.`,
    });
    const id = await runInDurableObject(await a.sandbox(), (_i, state) =>
      String(
        state.storage.sql.exec<{ id: string }>("SELECT id FROM posts WHERE slug = ?", slug).one()
          .id,
      ),
    );
    const settings = await a.fetch(`/api/posts/${id}/settings`, {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ email_only: true }),
    });
    expect(settings.status).toBe(200);
    await settings.arrayBuffer();
    const read = await a.json<{ post: { unlisted_token: string } }>(`/api/posts/${id}`);
    token = read.body.post.unlisted_token;
    await b.fetch("/api/posts"); // B has a sandbox of its own
  });

  it("is the post's page in its own sandbox", async () => {
    expect(token).toMatch(/\S/);
    const page = await a.fetch(`/email/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(marker);
  });

  it("answers nothing of it in another sandbox, or for a visitor with no cookie", async () => {
    const other = await b.fetch(`/email/${token}`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain(marker);
    const fresh = await SELF.fetch(`${BASE}/email/${token}`, {
      headers: { "cf-connecting-ip": "198.51.100.202" },
      redirect: "manual",
    });
    expect(fresh.status).toBe(404);
    expect(await fresh.text()).not.toContain(marker);
  });
});

describe("a list imported in one sandbox", () => {
  const a = visitor();
  const b = visitor();
  const address = `${MARKER}@example.com`;

  beforeAll(async () => {
    await a.fetch("/api/posts"); // a session first: a cookieless write starts none
    const imported = await importList(a, {
      name: "list.txt",
      text: `${address}\r\n`,
    });
    expect(imported.status).toBe(201);
    await b.fetch("/api/posts"); // B has a sandbox of its own
  });

  it("is in its own sandbox's export and subscriber list, and in neither of another's", async () => {
    expect((await exportList(a)).map((r) => r.email)).toContain(address);
    expect((await exportList(b)).map((r) => r.email)).not.toContain(address);
    const path = `/api/subscribers?search=${encodeURIComponent(MARKER)}`;
    const own = await a.fetch(path);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain(address);
    const other = await b.fetch(path);
    expect(other.status).toBe(200);
    expect(await other.text()).not.toContain(address);
  });
});

describe("a block or an erasure in one sandbox", () => {
  // Every sandbox is seeded with the same Field Notes list, so the same reader is in both:
  // what A does to them must not reach B's copy.
  const a = visitor();
  const b = visitor();
  let blocked = "";
  let erased = "";

  const lookup = (v: Visitor, email: string) =>
    v.json<{
      subscriber?: { status: string; unsubscribe_cause: string | null; suppression: object | null };
    }>(`/api/subscribers?email=${encodeURIComponent(email)}`);

  beforeAll(async () => {
    await a.fetch("/api/posts");
    await b.fetch("/api/posts");
    const readers = await runInDurableObject(await a.sandbox(), (_i, state) =>
      state.storage.sql
        .exec<{ id: string; email: string }>(
          `SELECT id, email FROM subscribers s WHERE status = 'confirmed'
             AND NOT EXISTS (SELECT 1 FROM suppressions p WHERE p.email = s.email)
           ORDER BY created_at LIMIT 2`,
        )
        .toArray()
        .map((r) => ({ id: String(r.id), email: String(r.email) })),
    );
    const [toBlock, toErase] = readers;
    if (!toBlock || !toErase) {
      throw new Error("the seed has fewer than two unsuppressed confirmed readers");
    }
    blocked = toBlock.email;
    erased = toErase.email;
    const block = await a.fetch("/api/suppressions", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ email: blocked }),
    });
    expect(block.status).toBe(201);
    await block.arrayBuffer();
    const erase = await a.fetch(`/api/subscribers/${toErase.id}/erase`, {
      method: "POST",
      headers: NO_BODY,
    });
    expect(erase.status).toBe(200);
    await erase.arrayBuffer();
  });

  it("suppresses the address in its own sandbox only", async () => {
    // A positive control: in A, the block holds and the erased reader is unsubscribed by it.
    expect((await lookup(a, blocked)).body.subscriber?.suppression).not.toBeNull();
    expect((await lookup(a, erased)).body.subscriber).toMatchObject({
      status: "unsubscribed",
      unsubscribe_cause: "erased",
    });
    for (const email of [blocked, erased]) {
      const other = await lookup(b, email);
      expect(other.status, email).toBe(200);
      expect(other.body.subscriber?.status, email).toBe("confirmed");
      expect(other.body.subscriber?.suppression, email).toBeNull();
      expect(other.body.subscriber?.unsubscribe_cause, email).toBeNull();
    }
    const own = await a.fetch("/api/suppressions");
    const ownText = await own.text();
    const theirs = await b.fetch("/api/suppressions");
    const theirsText = await theirs.text();
    // Since Kestrel 1.13.0 an erasure isn't a suppression, so only the block is listed.
    expect(ownText).toContain(blocked);
    expect(theirsText).not.toContain(blocked);
  });
});

describe("noindex", () => {
  it("is on every response class the Worker makes", async () => {
    const v = visitor();
    const sent = await v.json<{ posts: { slug: string }[] }>("/api/posts?status=sent");
    const seededSlug = sent.body.posts[0]?.slug;
    expect(seededSlug).toBeDefined();
    const paths = [
      "/api/posts", // API JSON, from a sandbox
      `/archive/${seededSlug}`, // a public HTML page
      "/media/posts/5eed0002-0000-4000-8000-000000000002/kestrel.webp", // media
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
