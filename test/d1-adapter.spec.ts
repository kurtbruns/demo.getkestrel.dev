// The D1 adapter (src/d1/adapter.ts) and the migration runner (src/d1/migrate.ts), against a
// real Durable Object's SQLite, on Kestrel's own schema at the pinned tag.

import { env, runInDurableObject } from "cloudflare:test";
import { demoImages, demoLogo, getConfig, migrations, seedDatabase } from "kestrel";
import { describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS, DurableObjectD1 } from "../src/d1/adapter";
import { migrate } from "../src/d1/migrate";
import { sandboxEnv } from "../src/sandbox";

/** Run `fn` inside a fresh sandbox DO, with Kestrel's schema applied unless told not to. */
function inSandbox<T>(
  fn: (db: DurableObjectD1, storage: DurableObjectStorage) => Promise<T> | T,
  { schema = true } = {},
): Promise<T> {
  const stub = env.SANDBOX.get(env.SANDBOX.newUniqueId());
  return runInDurableObject(stub, async (_instance, state) => {
    if (schema) {
      migrate(state.storage, migrations);
    }
    return fn(new DurableObjectD1(state.storage), state.storage);
  });
}

const NOW = 1_768_554_000_000;

function insertPost(db: DurableObjectD1, id: string, slug = id) {
  return db
    .prepare("INSERT INTO posts (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(id, slug, NOW, NOW);
}

function insertSend(db: DurableObjectD1, id: string, postId: string, status = "scheduled") {
  return db
    .prepare(
      `INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at)
       VALUES (?, ?, ?, ?, '<p>x</p>', 'x', 'Subject', ?)`,
    )
    .bind(id, postId, status, NOW + 60_000, NOW);
}

describe("migrations", () => {
  it("apply Kestrel's migrations cleanly, once", async () => {
    await inSandbox(
      (_db, storage) => {
        expect(migrate(storage, migrations)).toEqual(migrations.map((m) => m.name));
        expect(migrate(storage, migrations)).toEqual([]);
        // Every table, index and added column Kestrel's migrations declare exists.
        const objects = new Set(
          storage.sql
            .exec<{ name: string }>("SELECT name FROM sqlite_master")
            .toArray()
            .map((r) => r.name),
        );
        const all = migrations.map((m) => m.sql).join("\n");
        const declared = [
          ...all.matchAll(
            /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi,
          ),
        ].map((m) => m[1]);
        expect(declared.length).toBeGreaterThan(10);
        for (const name of declared) {
          expect(objects, name).toContain(name);
        }
        for (const [, table, column] of all.matchAll(
          /ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)/gi,
        )) {
          const columns = storage.sql
            .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
            .toArray()
            .map((r) => r.name);
          expect(columns, `${table}.${column}`).toContain(column);
        }
      },
      { schema: false },
    );
  });

  it("apply files that end in a comment, or are only comments, as wrangler does", async () => {
    await inSandbox(
      (_db, storage) => {
        const files = [
          { name: "0001_a.sql", sql: "CREATE TABLE a (x INTEGER); -- a trailing note" },
          { name: "0002_b.sql", sql: "CREATE TABLE b (x INTEGER);\n/* the end */\n" },
          { name: "0003_c.sql", sql: "-- nothing to do in this one\n" },
          { name: "0004_d.sql", sql: "CREATE TABLE d (x INTEGER)" },
        ];
        expect(migrate(storage, files)).toEqual(files.map((f) => f.name));
        const tables = storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((r) => r.name);
        expect(tables).toEqual(expect.arrayContaining(["a", "b", "d"]));
      },
      { schema: false },
    );
  });

  it("roll a failing migration back whole", async () => {
    await inSandbox(
      (_db, storage) => {
        const bad = { name: "9999_bad.sql", sql: "CREATE TABLE half (x INTEGER);\nNOT SQL;" };
        expect(() => migrate(storage, [bad])).toThrow();
        const half = storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name = 'half'")
          .toArray();
        expect(half).toEqual([]);
        expect(migrate(storage, migrations)).toHaveLength(migrations.length);
      },
      { schema: false },
    );
  });
});

describe("statements", () => {
  it("return D1-shaped results from first, all, run and raw", async () => {
    await inSandbox(async (db) => {
      const insert = await insertPost(db, "p1", "hello").run();
      expect(insert.success).toBe(true);
      expect(insert.results).toEqual([]);
      expect(insert.meta.changes).toBe(1);
      expect(insert.meta.changed_db).toBe(true);

      const select = db.prepare("SELECT id, slug FROM posts WHERE id = ?").bind("p1");
      expect(await select.first()).toEqual({ id: "p1", slug: "hello" });
      expect(await select.first("slug")).toBe("hello");
      expect(await select.all()).toMatchObject({
        success: true,
        results: [{ id: "p1", slug: "hello" }],
        meta: { changes: 0, changed_db: false },
      });
      expect(await select.raw()).toEqual([["p1", "hello"]]);
      expect(await select.raw({ columnNames: true })).toEqual([
        ["id", "slug"],
        ["p1", "hello"],
      ]);

      const none = db.prepare("SELECT id FROM posts WHERE id = ?").bind("missing");
      expect(await none.first()).toBeNull();
      expect(await none.first("id")).toBeNull();
      // As D1: no row is null even for a column the query doesn't have.
      expect(await none.first("nope")).toBeNull();
      await expect(select.first("nope")).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
    });
  });

  it("count changes for insert, update and delete, not index writes", async () => {
    await inSandbox(async (db) => {
      await db.batch([insertPost(db, "a"), insertPost(db, "b"), insertPost(db, "c")]);
      const update = await db
        .prepare("UPDATE posts SET subject = 'x' WHERE id IN ('a', 'b')")
        .run();
      expect(update.meta.changes).toBe(2);
      const noop = await db.prepare("UPDATE posts SET subject = 'x' WHERE id = 'zzz'").run();
      expect(noop.meta.changes).toBe(0);
      const ignored = await db
        .prepare(
          "INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('a', 'a', 1, 1) ON CONFLICT DO NOTHING",
        )
        .run();
      expect(ignored.meta.changes).toBe(0);
      const del = await db.prepare("DELETE FROM posts").run();
      expect(del.meta.changes).toBe(3);
    });
  });

  it("support RETURNING, json_each list binding, and booleans", async () => {
    await inSandbox(async (db) => {
      const returned = await db
        .prepare(
          "INSERT INTO posts (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id, slug",
        )
        .bind("r1", "returned", NOW, NOW)
        .all();
      expect(returned.results).toEqual([{ id: "r1", slug: "returned" }]);
      expect(returned.meta.changes).toBe(1);

      await insertPost(db, "r2").run();
      const listed = await db
        .prepare("SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
        .bind(JSON.stringify(["r1", "r2", "nope"]))
        .all();
      expect(listed.results).toEqual([{ id: "r1" }, { id: "r2" }]);

      expect(await db.prepare("SELECT ? AS t, ? AS f").bind(true, false).first()).toEqual({
        t: 1,
        f: 0,
      });
    });
  });

  it("hold to D1's limits and Kestrel's schema rules", async () => {
    await inSandbox(async (db) => {
      const many = Array.from({ length: D1_MAX_BOUND_PARAMETERS + 1 }, (_, i) => i);
      expect(() => db.prepare(`SELECT ${many.map(() => "?").join(", ")}`).bind(...many)).toThrow(
        /at most 100 bound parameters/,
      );
      expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow(/D1_TYPE_ERROR/);
      // D1 refuses a bigint rather than lose its precision.
      expect(() => db.prepare("SELECT ?").bind(2n ** 62n)).toThrow(/D1_TYPE_ERROR/);
      // ...and takes an array of byte values as a blob.
      const blob = await db.prepare("SELECT ? AS b").bind([1, 2, 3]).first<ArrayBuffer>("b");
      expect([...new Uint8Array(blob ?? new ArrayBuffer(0))]).toEqual([1, 2, 3]);
      // STRICT: a text id where an INTEGER goes is refused, not stored.
      await expect(
        db
          .prepare(
            "INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('s', 's', 'soon', 1)",
          )
          .run(),
      ).rejects.toThrow(/cannot store TEXT value in INTEGER column/);
      // Foreign keys are enforced, as on D1.
      await expect(insertSend(db, "orphan", "no-such-post").run()).rejects.toThrow(/FOREIGN KEY/);
    });
  });

  it("let SQLite's constraint text through, as Kestrel matches it", async () => {
    await inSandbox(async (db) => {
      await insertPost(db, "p").run();
      await insertSend(db, "s1", "p").run();
      // Kestrel's isActiveSendConflict (src/send/schedule.ts) matches this pattern.
      await expect(insertSend(db, "s2", "p").run()).rejects.toThrow(
        /UNIQUE constraint failed:\s*sends\.post_id/i,
      );
      // The same through batch, which is how Kestrel schedules (src/send/schedule.ts).
      await expect(db.batch([insertSend(db, "s2b", "p")])).rejects.toThrow(
        /UNIQUE constraint failed:\s*sends\.post_id/i,
      );
      // A canceled send doesn't count, per the partial index.
      await db.prepare("UPDATE sends SET status = 'canceled' WHERE id = 's1'").run();
      await insertSend(db, "s3", "p").run();
    });
  });
});

describe("batch", () => {
  it("is atomic: a failing statement leaves no trace of the ones before it", async () => {
    await inSandbox(async (db) => {
      await expect(
        db.batch([insertPost(db, "x1"), insertPost(db, "x2"), insertPost(db, "x1")]),
      ).rejects.toThrow(/UNIQUE constraint failed: posts\./);
      expect(await db.prepare("SELECT count(*) AS n FROM posts").first("n")).toBe(0);
    });
  });

  it("returns each statement's rows, read in one snapshot", async () => {
    await inSandbox(async (db) => {
      await insertPost(db, "a").run();
      const [count, inserted, after] = await db.batch([
        db.prepare("SELECT count(*) AS n FROM posts"),
        insertPost(db, "b"),
        db.prepare("SELECT id FROM posts ORDER BY id"),
      ]);
      expect(count?.results).toEqual([{ n: 1 }]);
      expect(inserted?.meta.changes).toBe(1);
      expect(after?.results).toEqual([{ id: "a" }, { id: "b" }]);
    });
  });

  it("runs exec's statements", async () => {
    await inSandbox(async (db) => {
      const result = await db.exec(
        "INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('e1', 'e1', 1, 1); INSERT INTO posts (id, slug, created_at, updated_at) VALUES ('e2', 'e2', 1, 1)",
      );
      expect(result.count).toBe(2);
      expect(await db.prepare("SELECT count(*) AS n FROM posts").first("n")).toBe(2);
    });
  });
});

describe("Kestrel on the adapter", () => {
  it("runs Kestrel's full Field Notes seed", async () => {
    await inSandbox(async (db) => {
      const kenv = sandboxEnv(env, db.asD1(), env.MEDIA);
      const summary = await seedDatabase(kenv, getConfig(kenv), demoImages, demoLogo);
      expect(summary.posts.sent).toBeGreaterThan(0);
      expect(summary.posts.draft).toBeGreaterThan(0);
      expect(summary.subscribers.confirmed).toBeGreaterThan(100);
      expect(summary.imagesWritten).toBe(demoImages.length);
      expect(summary.logoWritten).toBe(true);
      const posts = await db.prepare("SELECT count(*) AS n FROM posts").first<number>("n");
      expect(posts).toBe(summary.posts.sent + summary.posts.scheduled + summary.posts.draft);
    });
  });
});
