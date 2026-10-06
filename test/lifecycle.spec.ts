// A sandbox's lifecycle (DESIGN.md, "Lifecycle"): it's deleted once its visitor has been
// gone the idle TTL, a visitor can reset it, and one seeded by another Kestrel release
// starts over.

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureSeeded, sandboxEnv } from "../src/sandbox";
import { IDLE_TTL_MS, RESET_PATH } from "../src/sandbox_do";
import { mintSession, SESSION_COOKIE, sandboxName } from "../src/session";
import { BASE, SAME_ORIGIN, type Visitor, visitor } from "./support";

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const EDITED = "Edited before the lifecycle event";

interface PostList {
  posts: { id: string; subject: string }[];
}

/** Edit a seeded draft's subject and upload an image, so there's something to lose. */
async function makeChanges(v: Visitor): Promise<void> {
  const { body } = await v.json<PostList>("/posts?status=draft");
  const draft = body.posts[0]?.id;
  expect(draft).toBeDefined();
  const saved = await v.fetch(`/posts/${draft}`, {
    method: "PUT",
    headers: SAME_ORIGIN,
    body: JSON.stringify({ subject: EDITED }),
  });
  expect(saved.status).toBe(200);
  const uploaded = await v.fetch(`/posts/${draft}/images?filename=mine.png`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, "content-type": "image/png" },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(uploaded.status).toBe(201);
}

async function subjects(v: Visitor): Promise<string[]> {
  const { body } = await v.json<PostList>("/posts?status=draft");
  return body.posts.map((p) => p.subject);
}

async function ownObjects(stub: DurableObjectStub): Promise<number> {
  const prefix = await runInDurableObject(
    stub as DurableObjectStub<import("../src/sandbox_do").SandboxDO>,
    (i) => i.media.sessionPrefix,
  );
  return (await env.MEDIA.list({ prefix })).objects.length;
}

async function tables(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'",
      )
      .toArray()
      .map((r) => r.name),
  );
}

async function seedCount(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (_i, state) =>
    Number(
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM demo_meta WHERE key = 'seed_count'")
        .toArray()[0]?.value ?? 0,
    ),
  );
}

describe("the idle TTL", () => {
  it("deletes a sandbox whose visitor has been gone that long", async () => {
    const v = visitor();
    await makeChanges(v);
    const stub = await v.sandbox();
    expect(await ownObjects(stub)).toBe(1);

    // The visitor was last here a TTL and a second ago; the alarm is due at that expiry.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE demo_meta SET value = ? WHERE key = 'last_seen'",
        String(Date.now() - IDLE_TTL_MS - 1000),
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await tables(stub)).toEqual([]);
    expect(await ownObjects(stub)).toBe(0);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();

    // The same cookie gets a fresh sandbox: the seed again, and none of the changes.
    expect(await subjects(v)).not.toContain(EDITED);
    expect(await seedCount(stub)).toBe(1);
    expect((await v.fetch("/posts?status=draft")).status).toBe(200);
  });

  it("is pushed out by every request", async () => {
    const v = visitor();
    await v.fetch("/posts");
    const stub = await v.sandbox();
    const old = Date.now() - 60 * 60 * 1000;
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("UPDATE demo_meta SET value = ? WHERE key = 'last_seen'", String(old));
      await state.storage.setAlarm(old + IDLE_TTL_MS);
    });
    const before = Date.now();
    await v.fetch("/posts");
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + IDLE_TTL_MS);
  });
});

describe("Reset demo", () => {
  it("discards the visitor's changes and restores the seed", async () => {
    const v = visitor();
    await makeChanges(v);
    const stub = await v.sandbox();
    expect(await subjects(v)).toContain(EDITED);

    const res = await v.fetch(RESET_PATH, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard/");

    expect(await subjects(v)).not.toContain(EDITED);
    expect(await subjects(v)).toContain("Try editing this draft");
    expect(await ownObjects(stub)).toBe(0);
    expect(await seedCount(stub)).toBe(1); // a fresh database, seeded once
  });

  it("refuses a cross-site post, and anything but GET or POST", async () => {
    const v = visitor();
    await makeChanges(v);
    const cross = await v.fetch(RESET_PATH, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    const foreignOrigin = await v.fetch(RESET_PATH, {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
    });
    expect(foreignOrigin.status).toBe(403);
    // GET is the confirmation page; anything but GET or POST is refused.
    expect((await v.fetch(RESET_PATH, { method: "PUT" })).status).toBe(405);
    expect(await subjects(v)).toContain(EDITED);
  });
});

describe("a sandbox seeded by another Kestrel release", () => {
  it("starts over on its first request", async () => {
    const { token, value } = await mintSession(SECRET);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(SECRET, token)));
    // An older release's sandbox: seeded under another tag, with a visitor's own post and
    // an upload, and never started by this code.
    await runInDurableObject(stub, async (instance, state) => {
      const { migrate } = await import("../src/d1/migrate");
      const { migrations } = await import("kestrel");
      migrate(state.storage, migrations);
      const senv = sandboxEnv(env, instance.db.asD1(), instance.media.seedView());
      await ensureSeeded(senv, "v0.0.0-older");
      state.storage.sql.exec(
        "INSERT INTO posts (id, slug, subject, created_at, updated_at) VALUES ('old', 'old', ?, 1, 1)",
        EDITED,
      );
      await instance.media.put("posts/old/x.png", new Uint8Array(3));
    });
    expect(await ownObjects(stub)).toBe(1);

    const v = visitor();
    v.cookie = `${SESSION_COOKIE}=${value}`;
    const { body } = await v.json<PostList>("/posts");
    expect(body.posts.map((p) => p.subject)).not.toContain(EDITED);
    expect(body.posts.map((p) => p.subject)).toContain("Try editing this draft");
    expect(await ownObjects(stub)).toBe(0);
    expect(await seedCount(stub)).toBe(1);
  });
});

describe("the alarm", () => {
  it("wipes a sandbox seeded by another release, and never seeds it", async () => {
    const v = visitor();
    await v.fetch("/posts");
    const stub = await v.sandbox();
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE demo_meta SET value = 'v0.0.0-older' WHERE key = 'seeded_kestrel'",
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tables(stub)).toEqual([]);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });

  it("clears itself on a sandbox that was never used", async () => {
    const stub = env.SANDBOX.get(env.SANDBOX.newUniqueId());
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // Not seeded, not migrated: only the media wrapper's own bookkeeping tables, which it
    // creates as the object starts.
    expect((await tables(stub)).sort()).toEqual(["demo_media", "demo_media_tombstones"]);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });

  it("leaves a sandbox alone before its expiry", async () => {
    const v = visitor();
    await makeChanges(v);
    const stub = await v.sandbox();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await subjects(v)).toContain(EDITED);
  });
});

describe("Reset demo, from outside", () => {
  it("is refused from a sibling site", async () => {
    const v = visitor();
    await makeChanges(v);
    const res = await v.fetch(RESET_PATH, {
      method: "POST",
      headers: { "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(403);
    expect(await subjects(v)).toContain(EDITED);
  });

  it("sends a visitor with no sandbox back to the editor, starting nothing", async () => {
    const res = await SELF.fetch(`${BASE}${RESET_PATH}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "cf-connecting-ip": "198.51.100.230" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard/");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("shares the new-session rate limit", async () => {
    const v = visitor("203.0.113.77");
    await v.fetch("/posts"); // one new session from this IP
    const statuses: number[] = [];
    for (let i = 0; i < 25 && !statuses.includes(429); i++) {
      const res = await v.fetch(RESET_PATH, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        redirect: "manual",
      });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(303));
    expect(statuses).toContain(429);
  });
});
