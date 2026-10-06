// Kestrel's own default export, run by the wrapper on the sandbox env at the production
// origin, with only the patch set changed: the seed loads on first use, the admin API
// answers with no credentials (patches/0001-demo-auth.patch) while the dev routes stay
// absent, and the public archive serves a seeded post with its image.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://demo.getkestrel.dev";

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await SELF.fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

interface PostRow {
  id: string;
  slug: string;
  status: string;
}

describe("Kestrel under the wrapper", () => {
  it("seeds Field Notes on first use and lists its posts with no credentials", async () => {
    const { status, body } = await json<{ posts: PostRow[]; page: { total: number } }>("/posts");
    expect(status).toBe(200);
    expect(body.page.total).toBeGreaterThanOrEqual(7);
    const statuses = new Set(body.posts.map((p) => p.status));
    expect(statuses).toContain("sent");
    expect(statuses).toContain("draft");
  });

  it("reports the demo principal and auth mode", async () => {
    const { status, body } = await json<{
      principal: { kind: string; email: string };
      auth: { mode: string };
    }>("/api/whoami");
    expect(status).toBe(200);
    expect(body.auth.mode).toBe("demo");
    expect(body.principal).toEqual({ kind: "human", email: "demo@getkestrel.dev" });
  });

  it("keeps Kestrel's dev routes absent", async () => {
    expect((await SELF.fetch(`${BASE}/api/dev/token`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/dev/seed`, { method: "POST" })).status).toBe(404);
  });

  it("still refuses a cross-site admin write", async () => {
    const res = await SELF.fetch(`${BASE}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ title: "From elsewhere" }),
    });
    expect(res.status).toBe(403);
  });

  it("serves a seeded post's archive page, its cover image and the logo", async () => {
    const { body } = await json<{ posts: PostRow[] }>("/posts?status=sent");
    const srcs = new Set<string>();
    for (const post of body.posts) {
      const page = await SELF.fetch(`${BASE}/archive/${post.slug}`);
      expect(page.status).toBe(200);
      for (const m of (await page.text()).matchAll(/<img[^>]+src="([^"]*\/media\/[^"]+)"/g)) {
        srcs.add(m[1] ?? "");
      }
    }
    const cover = [...srcs].find((s) => s.includes("/media/posts/"));
    const logo = [...srcs].find((s) => s.includes("/media/branding/"));
    for (const [src, type] of [
      [cover, "image/webp"],
      [logo, "image/png"],
    ] as const) {
      expect(src, `an archive page shows a ${type}`).toBeDefined();
      const image = await SELF.fetch(new URL(src ?? "", BASE));
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe(type);
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
  });
});
