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
import { exportList, importList, NO_BODY, SAME_ORIGIN, savePost, visitor } from "./support";

interface PostRow {
  id: string;
  slug: string;
  status: string;
  subject: string;
  email_only: boolean;
}

describe("Kestrel in a sandbox", () => {
  const me = visitor();

  it("seeds Field Notes on first use and lists its posts with no credentials", async () => {
    const { status, body } = await me.json<{ posts: PostRow[]; page: { total: number } }>(
      "/api/posts",
    );
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
    const res = await me.fetch("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ subject: "From elsewhere" }),
    });
    expect(res.status).toBe(403);
  });

  it("shows the demo pill on the reader pages as served, never in Settings' previews of them", async () => {
    for (const path of ["/", "/subscribe", "/archive/nope", "/unsubscribe?test=1"]) {
      expect(await (await me.fetch(path)).text(), path).toContain('class="r-demo"');
    }
    for (const page of [
      "subscribe/form",
      "confirm/ready",
      "unsubscribe/ask",
      "reading/not-found",
    ]) {
      const res = await me.fetch(`/api/reader-pages/${page}`);
      expect(res.status).toBe(200);
      expect(await res.text(), page).not.toContain("r-demo");
    }
  });

  it("leaves the demo pill out of a post's web version, which the editor frames", async () => {
    const { body } = await me.json<{ posts: PostRow[] }>("/api/posts?status=draft");
    const res = await me.fetch(`/api/posts/${body.posts[0]?.id}/web`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("r-demo");
  });

  it("serves a seeded post's archive page, its cover image and the logo", async () => {
    const { body } = await me.json<{ posts: PostRow[] }>("/api/posts?status=sent");
    const srcs = new Set<string>();
    // An email-only post (since v1.12.0 the seed opens with one) has no archive page.
    const listed = body.posts.filter((p) => !p.email_only);
    expect(listed.length).toBeGreaterThan(0);
    for (const post of listed) {
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
    expect(Object.keys(sandboxEnv(env, {} as D1Database, {} as R2Bucket)).sort()).toEqual(
      [
        "ALLOW_FAKE_PROVIDER",
        "APP_ORIGIN",
        "ARCHIVE_BASE_PATH",
        "AWS_REGION",
        "DB",
        "FROM_ADDRESS",
        "MEDIA",
        "MIN_LEAD_SECONDS",
        "PROVIDER",
        "SENDING_DOMAIN",
        "SUBREQUEST_BUDGET",
      ].sort(),
    );
    const { status, body } = await me.json<{
      deployment: {
        provider: string;
        access_configured: boolean;
        auth_mode: string;
        free_plan_limits: boolean;
      };
    }>("/api/settings");
    expect(status).toBe(200);
    expect(body.deployment).toMatchObject({
      provider: "fake",
      access_configured: false,
      auth_mode: "demo",
      // SUBREQUEST_BUDGET is above Workers Free's default, so no warnings about D1's daily
      // writes, which a sandbox's SQLite doesn't have.
      free_plan_limits: false,
    });
  });

  it("caps an import at 1,000 rows, as the format says (patches/0005-demo-import-limit.patch)", async () => {
    const { body: format } = await me.json<{
      limits: { max_rows: number; max_rows_reason: string | null };
    }>("/api/imports/format");
    expect(format.limits.max_rows).toBe(1_000);
    expect(format.limits.max_rows_reason).toMatch(/demo sandbox/);
    const list = (n: number) => ({
      name: "list.txt",
      text: Array.from({ length: n }, (_, i) => `capped-${i}@example.com\r\n`).join(""),
    });
    const plan = (n: number) =>
      me.json<{ error?: string; limit?: number; counts?: Record<string, number> }>(
        "/api/imports/plan",
        { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ file: list(n) }) },
      );
    const over = await plan(1_001);
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ error: "too_many_rows", limit: 1_000 });
    const at = await plan(1_000);
    expect(at.status).toBe(200);
    expect(at.body.counts?.added_confirmed).toBe(1_000);
  });

  it("imports a list through the adapter and exports it back", async () => {
    const imported = await importList(me, {
      name: "list.csv",
      text: "email,status,opt_in,origin\r\nimported-ada@example.com,subscribed,double,sendy\r\nimported-edsger@example.com,unsubscribed,unknown,sendy\r\n",
    });
    expect(imported.counts).toMatchObject({ added_confirmed: 1, added_unsubscribed: 1 });
    expect(imported.status).toBe(201);

    const exported = await exportList(me);
    expect(exported.find((r) => r.email === "imported-ada@example.com")).toMatchObject({
      status: "subscribed",
      origin: "sendy",
    });
    expect(exported.find((r) => r.email === "imported-edsger@example.com")).toMatchObject({
      status: "unsubscribed",
    });
    expect(new Set(exported.map((r) => r.email)).size).toBe(exported.length);
  });

  it("erases a reader who was mailed, through the adapter, and every send still adds up", async () => {
    // Kestrel's erase is one four-statement batch whose first `meta.changes` says whether it
    // happened and whose last says how many past deliveries now show an erased recipient, so
    // both depend on the adapter's counts being exact (DESIGN.md, the D1-compatible adapter).
    const stub = await me.sandbox();
    const reader = await runInDurableObject(stub, (_i, state) => {
      const row = state.storage.sql
        .exec<{ id: string; email: string }>(
          `SELECT id, email FROM subscribers s WHERE status = 'confirmed'
             AND NOT EXISTS (SELECT 1 FROM suppressions p WHERE p.email = s.email)
             AND EXISTS (SELECT 1 FROM deliveries d WHERE d.email = s.email)
           ORDER BY created_at LIMIT 1`,
        )
        .one();
      const sendIds = state.storage.sql
        .exec<{ send_id: string }>(
          "SELECT DISTINCT send_id FROM deliveries WHERE email = ? ORDER BY send_id",
          row.email,
        )
        .toArray()
        .map((r) => String(r.send_id));
      const mailed = state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE email = ?", row.email)
        .one().n;
      return { id: String(row.id), email: String(row.email), sendIds, mailed: Number(mailed) };
    });
    expect(reader.mailed).toBeGreaterThan(0);

    type SendView = { send: { audience: { count: number }; counts: Record<string, number> } };
    const records = async () =>
      Promise.all(
        reader.sendIds.map(async (id) => {
          const { status, body } = await me.json<SendView>(`/api/sends/${id}`);
          expect(status).toBe(200);
          return { audience: body.send.audience.count, counts: body.send.counts };
        }),
      );
    const before = await records();

    type Erased = { email: string; status: string; unsubscribe_cause: string | null };
    const erased = await me.json<{ subscriber: Erased; deliveries: number }>(
      `/api/subscribers/${reader.id}/erase`,
      { method: "POST", headers: NO_BODY },
    );
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    expect(erased.body.deliveries).toBe(reader.mailed);
    expect(erased.body.subscriber).toMatchObject({
      email: reader.email,
      status: "unsubscribed",
      unsubscribe_cause: "erased",
    });

    // The record still adds up: the same audience and buckets, with an erased recipient in
    // place of the address.
    expect(await records()).toEqual(before);
    const left = await runInDurableObject(stub, (_i, state) =>
      Number(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE email = ?", reader.email)
          .one().n,
      ),
    );
    expect(left).toBe(0);
    // What's left is the address, unsubscribed by the erasure.
    const remains = await me.json<{ subscriber: Erased }>(
      `/api/subscribers?email=${encodeURIComponent(reader.email)}`,
    );
    expect(remains.status).toBe(200);
    expect(remains.body.subscriber).toMatchObject({
      status: "unsubscribed",
      unsubscribe_cause: "erased",
    });

    // Only the person's own sign-up brings them back: the publisher can't re-add them.
    const readd = await me.json<{ error: string }>("/api/subscribers", {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ email: reader.email }),
    });
    expect(readd.status).toBe(409);
    expect(readd.body.error).toBe("signup_required");
  });

  it("saves a same-origin draft edit, which persists", async () => {
    const { body } = await me.json<{ posts: PostRow[] }>("/api/posts?status=draft");
    const draft = body.posts[0];
    expect(draft).toBeDefined();
    const saved = await savePost(me, draft?.id ?? "", { subject: "Edited in the sandbox" });
    expect(saved.status).toBe(200);
    const reread = await me.json<{ posts: PostRow[] }>("/api/posts?status=draft");
    expect(reread.body.posts.map((p) => p.subject)).toContain("Edited in the sandbox");
  });

  it("seeds once per Kestrel version, and again after a version change", async () => {
    await runInDurableObject(await me.sandbox(), async (instance: SandboxDO) => {
      const senv = sandboxEnv(env, instance.db.asD1(), instance.media.seedView());
      expect(await ensureSeeded(senv, BUILD_INFO.tag)).toBe(false);
      expect(await ensureSeeded(senv, "v0.0.0-older")).toBe(true);
      expect(await ensureSeeded(senv, "v0.0.0-older")).toBe(false);
      expect(await ensureSeeded(senv, BUILD_INFO.tag)).toBe(true);
    });
  });
});
