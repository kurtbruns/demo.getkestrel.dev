// Kestrel's own default export, run in a visitor's sandbox on the sandbox env at the
// production origin, with only the patch set changed: the seed loads on first use, the
// admin API answers with no credentials (patches/0001-demo-auth.patch) while the dev routes
// stay absent, and the public archive serves a seeded post with its image. vitest.config.ts
// binds a dev secret, Access settings and a real provider to the Worker, none of which may
// reach Kestrel.

import { env, runInDurableObject } from "cloudflare:test";
import { BUILD_INFO } from "kestrel";
import { describe, expect, it } from "vitest";
import { ensureSeeded, sandboxEnv } from "../src/sandbox";
import type { SandboxDO } from "../src/sandbox_do";
import { SAME_ORIGIN, visitor } from "./support";

interface PostRow {
  id: string;
  slug: string;
  status: string;
  subject: string;
}

describe("Kestrel in a sandbox", () => {
  const me = visitor();

  it("seeds Field Notes on first use and lists its posts with no credentials", async () => {
    const { status, body } = await me.json<{ posts: PostRow[]; page: { total: number } }>("/posts");
    expect(status).toBe(200);
    expect(body.page.total).toBeGreaterThanOrEqual(7);
    const statuses = new Set(body.posts.map((p) => p.status));
    expect(statuses).toContain("sent");
    expect(statuses).toContain("draft");
  });

  it("reports the demo principal and auth mode", async () => {
    const { status, body } = await me.json<{
      principal: { kind: string; email: string };
      auth: { mode: string };
    }>("/api/whoami");
    expect(status).toBe(200);
    expect(body.auth.mode).toBe("demo");
    expect(body.principal).toEqual({ kind: "human", email: "demo@getkestrel.dev" });
  });

  it("keeps Kestrel's dev routes absent", async () => {
    expect((await me.fetch("/api/dev/token")).status).toBe(404);
    expect((await me.fetch("/api/dev/seed", { method: "POST" })).status).toBe(404);
  });

  it("still refuses a cross-site admin write", async () => {
    const res = await me.fetch("/posts", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ subject: "From elsewhere" }),
    });
    expect(res.status).toBe(403);
  });

  it("serves a seeded post's archive page, its cover image and the logo", async () => {
    const { body } = await me.json<{ posts: PostRow[] }>("/posts?status=sent");
    const srcs = new Set<string>();
    for (const post of body.posts) {
      const page = await me.fetch(`/archive/${post.slug}`);
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
      const image = await me.fetch(new URL(src ?? "").pathname + new URL(src ?? "").search);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe(type);
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
  });

  it("builds Kestrel's env from an allowlist, whatever the Worker is bound", async () => {
    const worker = env as unknown as Record<string, unknown>;
    expect(worker.DEV_AUTH_SECRET).toBeDefined(); // the leak this guards against is set up
    expect(Object.keys(sandboxEnv(env, {} as D1Database)).sort()).toEqual(
      [
        "APP_ORIGIN",
        "ARCHIVE_BASE_PATH",
        "AWS_REGION",
        "DB",
        "FROM_ADDRESS",
        "MEDIA",
        "MIN_LEAD_SECONDS",
        "PROVIDER",
        "SENDING_DOMAIN",
      ].sort(),
    );
    const { status, body } = await me.json<{
      deployment: { provider: string; accessConfigured: boolean; authMode: string };
    }>("/api/settings");
    expect(status).toBe(200);
    expect(body.deployment).toMatchObject({
      provider: "fake",
      accessConfigured: false,
      authMode: "demo",
    });
  });

  it("saves a same-origin draft edit, which persists", async () => {
    const { body } = await me.json<{ posts: PostRow[] }>("/posts?status=draft");
    const draft = body.posts[0];
    expect(draft).toBeDefined();
    const saved = await me.fetch(`/posts/${draft?.id}`, {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ subject: "Edited in the sandbox" }),
    });
    expect(saved.status).toBe(200);
    const reread = await me.json<{ posts: PostRow[] }>("/posts?status=draft");
    expect(reread.body.posts.map((p) => p.subject)).toContain("Edited in the sandbox");
  });

  it("seeds once per Kestrel version, and again after a version change", async () => {
    await runInDurableObject(await me.sandbox(), async (instance: SandboxDO) => {
      const senv = sandboxEnv(env, instance.db.asD1());
      expect(await ensureSeeded(senv, BUILD_INFO.tag)).toBe(false);
      expect(await ensureSeeded(senv, "v0.0.0-older")).toBe(true);
      expect(await ensureSeeded(senv, "v0.0.0-older")).toBe(false);
      expect(await ensureSeeded(senv, BUILD_INFO.tag)).toBe(true);
    });
  });
});
