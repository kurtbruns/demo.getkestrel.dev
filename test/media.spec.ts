// A sandbox's media (src/media.ts): scoped to the session's own R2 prefix, sharing one copy
// of the seed's images, capped, and never cached for anyone else.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_OBJECT_BYTES, SandboxMedia } from "../src/media";
import { ensureSeeded, sandboxEnv } from "../src/sandbox";
import { SAME_ORIGIN, type Visitor, visitor } from "./support";

interface PostList {
  posts: { id: string; status: string }[];
}

async function keysUnder(prefix: string): Promise<string[]> {
  const listed = await env.MEDIA.list({ prefix });
  return listed.objects.map((o) => o.key);
}

async function sandboxPrefix(v: Visitor): Promise<string> {
  return runInDurableObject(await v.sandbox(), (instance) => instance.media.sessionPrefix);
}

async function bytesOf(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

/** Upload `bytes` as a post image in `v`'s sandbox, raw, as the editor can. */
function upload(v: Visitor, postId: string, filename: string, bytes: Uint8Array) {
  return v.fetch(`/posts/${postId}/images?filename=${filename}`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, "content-type": "image/png" },
    body: bytes,
  });
}

async function aDraft(v: Visitor): Promise<string> {
  const { body } = await v.json<PostList>("/posts?status=draft");
  const id = body.posts[0]?.id;
  if (!id) {
    throw new Error("no draft");
  }
  return id;
}

const COVER = "/media/posts/5eed0001-0000-4000-8000-000000000001/kestrel.webp";

describe("seed images", () => {
  it("are served in every sandbox from one shared copy", async () => {
    const a = visitor();
    const b = visitor();
    const fromA = await a.fetch(COVER);
    const fromB = await b.fetch(COVER);
    expect(fromA.status).toBe(200);
    expect(fromB.status).toBe(200);
    expect(await bytesOf(fromA)).toEqual(await bytesOf(fromB));
    const seed = await keysUnder("seed/");
    expect(seed.filter((k) => k.endsWith("/kestrel.webp"))).toHaveLength(1);
    expect(seed.filter((k) => k.endsWith("/branding/logo"))).toHaveLength(1);
    // Seeding wrote nothing under either sandbox's own prefix.
    expect(await keysUnder(await sandboxPrefix(a))).toEqual([]);
    expect(await keysUnder(await sandboxPrefix(b))).toEqual([]);
  });

  it("are served privately, never for a shared cache", async () => {
    const v = visitor();
    await v.fetch("/posts"); // the first response, which sets the cookie, is no-store
    const res = await v.fetch(COVER);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("vary")).toContain("Cookie");
    await res.arrayBuffer();
  });
});

describe("uploads", () => {
  it("are served to their own sandbox and 404 in another at the same path", async () => {
    const a = visitor();
    const b = visitor();
    const draft = await aDraft(a);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    expect((await upload(a, draft, "mine.png", bytes)).status).toBe(201);
    const path = `/media/posts/${draft}/mine.png`;
    const own = await a.fetch(path);
    expect(own.status).toBe(200);
    expect(await bytesOf(own)).toEqual([...bytes]);
    expect((await b.fetch(path)).status).toBe(404);
    const prefix = await sandboxPrefix(a);
    expect(await keysUnder(prefix)).toEqual([`${prefix}posts/${draft}/mine.png`]);
  });

  it("over the per-object cap are refused with a 413, and nothing is written", async () => {
    const a = visitor();
    const draft = await aDraft(a);
    const res = await upload(a, draft, "big.png", new Uint8Array(MAX_OBJECT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("upload_too_large");
    expect(await keysUnder(await sandboxPrefix(a))).toEqual([]);
    expect((await a.fetch(`/media/posts/${draft}/big.png`)).status).toBe(404);
  });

  it("past the sandbox's total are refused, and nothing is written", async () => {
    await runInDurableObject(
      await (async () => {
        const v = visitor();
        await v.fetch("/health"); // no session; mint one with a real request
        await v.fetch("/posts");
        return v.sandbox();
      })(),
      async (_instance, state) => {
        const media = new SandboxMedia(
          env.MEDIA,
          state.storage.sql,
          "sessions/cap-test/",
          "seed/x/",
          {
            object: 100,
            sandbox: 250,
          },
        );
        await media.put("a.png", new Uint8Array(100));
        await media.put("b.png", new Uint8Array(100));
        await expect(media.put("c.png", new Uint8Array(100))).rejects.toMatchObject({
          status: 413,
        });
        // Replacing an object counts its new size, not both.
        await media.put("b.png", new Uint8Array(50));
        await media.put("c.png", new Uint8Array(100));
        expect(media.usedBytes()).toBe(250);
        expect(await keysUnder("sessions/cap-test/")).toEqual([
          "sessions/cap-test/a.png",
          "sessions/cap-test/b.png",
          "sessions/cap-test/c.png",
        ]);
        await media.clear();
        expect(await keysUnder("sessions/cap-test/")).toEqual([]);
      },
    );
  });

  it("can't name a key or list outside the sandbox", async () => {
    const v = visitor();
    await v.fetch("/posts");
    await runInDurableObject(await v.sandbox(), async (instance) => {
      for (const key of ["../other/x", "/abs", "a//b", "", "a/./b"]) {
        // Kestrel's own HttpError, so its router answers a 4xx, never a 500.
        await expect(instance.media.get(key), key).rejects.toMatchObject({ status: 404 });
        await expect(instance.media.put(key, "x"), key).rejects.toMatchObject({ status: 400 });
      }
      await expect(instance.media.list({ prefix: "../" })).rejects.toMatchObject({ status: 400 });
      await instance.media.put("posts/p/x.png", new Uint8Array(3));
      const listed = await instance.media.list();
      expect(listed.objects.map((o) => o.key)).toEqual(["posts/p/x.png"]);
    });
  });
});

describe("hardening", () => {
  /** A media wrapper over a scratch prefix with small caps, inside a real sandbox DO. */
  async function scratchMedia<T>(fn: (media: SandboxMedia) => Promise<T>): Promise<T> {
    const v = visitor();
    await v.fetch("/posts");
    return runInDurableObject(await v.sandbox(), (_i, state) =>
      fn(
        new SandboxMedia(
          env.MEDIA,
          state.storage.sql,
          `sessions/${crypto.randomUUID()}/`,
          "seed/x/",
          {
            object: 100,
            sandbox: 250,
          },
        ),
      ),
    );
  }

  it("holds the sandbox total against uploads running in parallel", async () => {
    await scratchMedia(async (media) => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => media.put(`p${i}.png`, new Uint8Array(100))),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
      expect(media.usedBytes()).toBe(200);
    });
  });

  it("keeps a tombstone when a replacement upload is refused", async () => {
    await scratchMedia(async (media) => {
      await media.seedView().put("cover.png", new Uint8Array([7, 7, 7]));
      expect(await media.get("cover.png")).not.toBeNull(); // the shared seed copy
      await media.delete("cover.png");
      expect(await media.get("cover.png")).toBeNull();
      await expect(media.put("cover.png", new Uint8Array(101))).rejects.toMatchObject({
        status: 413,
      });
      expect(await media.get("cover.png")).toBeNull(); // still deleted
    });
  });

  it("answers a 404 or a 400, not a 500, for a key that would leave the sandbox", async () => {
    const v = visitor();
    const draft = await aDraft(v);
    const traversal = await v.fetch("/media/posts/..%2F..%2Fx");
    expect(traversal.status).toBe(404);
    await traversal.arrayBuffer();
    const dotdot = await upload(v, draft, "..", new Uint8Array([1]));
    expect(dotdot.status).toBe(400);
    await dotdot.arrayBuffer();
  });

  it("refuses an oversized or unsized upload before Kestrel reads it", async () => {
    const v = visitor();
    const draft = await aDraft(v);
    const big = await upload(v, draft, "big.png", new Uint8Array(MAX_OBJECT_BYTES + 300 * 1024));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe("upload_too_large");
    const unsized = await v.fetch(`/posts/${draft}/images?filename=s.png`, {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "image/png" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
    });
    expect(unsized.status).toBe(411);
    await unsized.arrayBuffer();
  });

  it("writes the shared seed copy once, not again for each new sandbox", async () => {
    await visitor().fetch(COVER);
    const key = (await keysUnder("seed/")).find((k) => k.endsWith("/kestrel.webp")) ?? "";
    const before = await env.MEDIA.head(key);
    await visitor().fetch(COVER); // a second sandbox seeds
    const after = await env.MEDIA.head(key);
    expect(after?.uploaded.getTime()).toBe(before?.uploaded.getTime());
    expect(after?.etag).toBe(before?.etag);
  });

  it("clears a sandbox's uploads when it's seeded again", async () => {
    const v = visitor();
    const draft = await aDraft(v);
    expect((await upload(v, draft, "mine.png", new Uint8Array([1, 2]))).status).toBe(201);
    const stub = await v.sandbox();
    await runInDurableObject(stub, async (instance) => {
      const senv = sandboxEnv(env, instance.db.asD1(), instance.media.seedView());
      expect(await ensureSeeded(senv, "v0.0.0-other", () => instance.media.clear())).toBe(true);
      expect(instance.media.usedBytes()).toBe(0);
    });
    expect(await keysUnder(await sandboxPrefix(v))).toEqual([]);
  });
});

describe("the logo", () => {
  /**
   * A logo change re-makes the seeded scheduled send, which Kestrel asks the editor to
   * confirm (a 409 naming the sends); confirm it, as the editor does.
   */
  async function confirmingRemake(send: (query: string) => Promise<Response>): Promise<Response> {
    const first = await send("");
    if (first.status !== 409) {
      return first;
    }
    const { error, sends } = (await first.json()) as { error: string; sends: { id: string }[] };
    expect(error).toBe("remake_required");
    return send(`?remake=${sends.map((x) => x.id).join(",")}`);
  }

  function postLogo(v: Visitor, bytes: Uint8Array) {
    return confirmingRemake((query) => {
      const form = new FormData();
      form.append("file", new File([bytes], "logo.png", { type: "image/png" }));
      return v.fetch(`/api/settings/logo${query}`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        body: form,
      });
    });
  }

  it("replaced in one sandbox stays the seed's in another", async () => {
    const a = visitor();
    const b = visitor();
    await a.fetch("/posts"); // a session starts with a GET
    const seedLogo = await bytesOf(await b.fetch("/media/branding/logo"));
    const mine = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]);
    expect((await postLogo(a, mine)).status).toBe(200);
    expect(await bytesOf(await a.fetch("/media/branding/logo"))).toEqual([...mine]);
    expect(await bytesOf(await b.fetch("/media/branding/logo"))).toEqual(seedLogo);
  });

  it("removed in one sandbox stays removed there, and nowhere else", async () => {
    const a = visitor();
    const b = visitor();
    expect((await a.fetch("/media/branding/logo")).status).toBe(200);
    const removed = await confirmingRemake((query) =>
      a.fetch(`/api/settings/logo${query}`, {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(removed.status).toBe(200);
    expect((await a.fetch("/media/branding/logo")).status).toBe(404);
    expect((await b.fetch("/media/branding/logo")).status).toBe(200);
  });
});
