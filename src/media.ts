/**
 * A sandbox's `MEDIA`: the R2 bucket, scoped to one session (DESIGN.md, "Media").
 *
 * Every key Kestrel uses is rewritten under the sandbox's own prefix,
 * `sessions/<sandbox id>/`, so a sandbox can only address its own objects. The seed's images
 * are the exception: the seed writes them through a separate view (`seedView`) to a prefix
 * every sandbox shares, `seed/<kestrel tag>/`, once, and a sandbox's read of a key it doesn't
 * hold falls back there, so a new sandbox writes no image bytes. Only the seed is ever handed
 * that view; the bucket Kestrel's request handlers see can never write to the shared prefix.
 * Deleting a key leaves a tombstone, so a deleted seed image (a removed logo, a deleted
 * post's cover) stays deleted for that sandbox.
 *
 * Uploads are capped per object and per sandbox, with the byte count and tombstones kept in
 * the sandbox's own SQLite. Over a cap, `put` throws Kestrel's own `HttpError(413)`, which
 * Kestrel's router answers as a 413 with its usual error body, and nothing is written. The
 * size is reserved before the bytes go to R2, so uploads running in parallel (a DO serves
 * other requests while it awaits R2) can't pass the cap together.
 *
 * Kestrel uses `get`, `put` (with `httpMetadata`) and `delete`; `head` and `list` are here
 * for the demo's own use, and `list` stays inside the sandbox's prefix.
 */

import { HttpError } from "kestrel";

/** The largest object a visitor may upload. It binds post images (Kestrel's own cap is
 *  5 MB); the logo has Kestrel's tighter 512 KB cap already. */
export const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
/** The most a sandbox may hold in uploads, beside the shared seed images. */
export const MAX_SANDBOX_BYTES = 20 * 1024 * 1024;

export class MediaQuotaError extends HttpError {
  constructor(message: string) {
    super(413, "upload_too_large", message);
    this.name = "MediaQuotaError";
  }
}

type PutValue = Parameters<R2Bucket["put"]>[1];

const mb = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 100) / 100}`;

function byteLength(value: PutValue): number | undefined {
  if (value === null) {
    return 0;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (value instanceof Blob) {
    return value.size;
  }
  return undefined; // a stream: unknown until read
}

/**
 * A key as Kestrel names it: relative, with no empty, `.` or `..` segments. Anything else is
 * Kestrel's own `HttpError`, so its router answers a 4xx rather than a 500: a 404 where the
 * key came from a URL (`/media/:key`, which the router decodes), a 400 for a write.
 */
function checkKey(key: string, status: 400 | 404): string {
  if (
    key === "" ||
    key.startsWith("/") ||
    key.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw status === 404
      ? new HttpError(404, "not_found", "media not found")
      : new HttpError(400, "bad_media_key", `media key refused: ${JSON.stringify(key)}`);
  }
  return key;
}

export class SandboxMedia {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly sql: SqlStorage,
    /** `sessions/<sandbox id>/` */
    readonly sessionPrefix: string,
    /** `seed/<kestrel tag>/` */
    readonly seedPrefix: string,
    private readonly caps = { object: MAX_OBJECT_BYTES, sandbox: MAX_SANDBOX_BYTES },
  ) {
    this.init();
  }

  /** Create the wrapper's own tables; again after the sandbox's storage is wiped (#8). */
  init(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS demo_media (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL) STRICT",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS demo_media_tombstones (key TEXT PRIMARY KEY) STRICT");
  }

  /** As Kestrel's request handlers see it: the `R2Bucket` type, scoped to this sandbox. */
  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  /**
   * The bucket only Kestrel's seed is given: a `put` writes the shared seed copy (once) and
   * drops anything of this sandbox's that would shadow it, so a re-seed restores the seed's
   * images. Reads behave as the sandbox's own. Never handed to a request handler.
   */
  seedView(): R2Bucket {
    const view = {
      get: (key: string, options?: R2GetOptions) => this.get(key, options),
      head: (key: string) => this.head(key),
      put: async (key: string, value: PutValue, options?: R2PutOptions) => {
        checkKey(key, 400);
        await this.bucket.delete(this.sessionPrefix + key);
        this.sql.exec("DELETE FROM demo_media WHERE key = ?", key);
        this.sql.exec("DELETE FROM demo_media_tombstones WHERE key = ?", key);
        return (
          (await this.bucket.head(this.seedPrefix + key)) ??
          (await this.bucket.put(this.seedPrefix + key, value, options))
        );
      },
      delete: (keys: string | string[]) => this.delete(keys),
    };
    return view as unknown as R2Bucket;
  }

  /** The bytes this sandbox's uploads hold. */
  usedBytes(): number {
    return this.sql.exec<{ n: number }>("SELECT coalesce(sum(bytes), 0) AS n FROM demo_media").one()
      .n;
  }

  private tombstoned(key: string): boolean {
    return (
      this.sql.exec("SELECT 1 FROM demo_media_tombstones WHERE key = ?", key).toArray().length > 0
    );
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    checkKey(key, 404);
    if (this.tombstoned(key)) {
      return null;
    }
    return (
      (await this.bucket.get(this.sessionPrefix + key, options)) ??
      (await this.bucket.get(this.seedPrefix + key, options))
    );
  }

  async head(key: string): Promise<R2Object | null> {
    checkKey(key, 404);
    if (this.tombstoned(key)) {
      return null;
    }
    return (
      (await this.bucket.head(this.sessionPrefix + key)) ??
      (await this.bucket.head(this.seedPrefix + key))
    );
  }

  async put(key: string, value: PutValue, options?: R2PutOptions): Promise<R2Object | null> {
    checkKey(key, 400);
    const size = byteLength(value);
    if (size === undefined) {
      throw new MediaQuotaError("an upload must have a known size");
    }
    if (size > this.caps.object) {
      throw new MediaQuotaError(`an upload must be ${mb(this.caps.object)} MB or smaller`);
    }
    // Check and reserve with no await between, so a parallel upload sees this one's size.
    const previous = this.sql
      .exec<{ bytes: number }>("SELECT bytes FROM demo_media WHERE key = ?", key)
      .toArray()[0]?.bytes;
    const others = this.usedBytes() - (previous ?? 0);
    if (others + size > this.caps.sandbox) {
      throw new MediaQuotaError(
        `this demo sandbox holds at most ${mb(this.caps.sandbox)} MB of uploads`,
      );
    }
    this.sql.exec(
      "INSERT INTO demo_media (key, bytes) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET bytes = excluded.bytes",
      key,
      size,
    );
    let object: R2Object | null;
    try {
      object = await this.bucket.put(this.sessionPrefix + key, value, options);
    } catch (err) {
      // Give back the reservation: the object is as it was.
      if (previous === undefined) {
        this.sql.exec("DELETE FROM demo_media WHERE key = ?", key);
      } else {
        this.sql.exec("UPDATE demo_media SET bytes = ? WHERE key = ?", previous, key);
      }
      throw err;
    }
    // Only a write that landed undoes a delete.
    this.sql.exec("DELETE FROM demo_media_tombstones WHERE key = ?", key);
    return object;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : [keys]).map((k) => checkKey(k, 400));
    await this.bucket.delete(list.map((k) => this.sessionPrefix + k));
    for (const key of list) {
      this.sql.exec("DELETE FROM demo_media WHERE key = ?", key);
      this.sql.exec("INSERT OR IGNORE INTO demo_media_tombstones (key) VALUES (?)", key);
    }
  }

  /** This sandbox's own objects (not the shared seed's), with keys as Kestrel names them. */
  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = options.prefix ?? "";
    if (prefix.startsWith("/") || prefix.split("/").some((s) => s === "." || s === "..")) {
      throw new HttpError(400, "bad_media_key", `media prefix refused: ${JSON.stringify(prefix)}`);
    }
    const listed = await this.bucket.list({ ...options, prefix: this.sessionPrefix + prefix });
    return {
      ...listed,
      objects: listed.objects.map((o) =>
        Object.assign(Object.create(Object.getPrototypeOf(o)), o, {
          key: o.key.slice(this.sessionPrefix.length),
        }),
      ),
    };
  }

  /** Delete every object this sandbox holds (not the shared seed's), and its records. */
  async clear(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: this.sessionPrefix, cursor });
      if (page.objects.length > 0) {
        await this.bucket.delete(page.objects.map((o) => o.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.sql.exec("DELETE FROM demo_media");
    this.sql.exec("DELETE FROM demo_media_tombstones");
  }
}
