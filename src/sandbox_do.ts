/**
 * One visitor's sandbox: a SQLite-backed Durable Object whose storage is that visitor's
 * Kestrel database, through the D1 adapter (DESIGN.md, "Architecture"). The Worker routes
 * every request the visitor makes here, by their session cookie (src/session.ts).
 */

import { DurableObject } from "cloudflare:workers";
import kestrel, { BUILD_INFO, type KestrelEnv, migrations } from "kestrel";
import { DurableObjectD1 } from "./d1/adapter";
import { migrate } from "./d1/migrate";
import { MAX_OBJECT_BYTES, SandboxMedia } from "./media";
import { ensureSeeded, sandboxEnv } from "./sandbox";

/** Uploads Kestrel takes (src/app.ts at the pinned tag). */
function isUpload(request: Request, path: string): boolean {
  return (
    request.method === "POST" &&
    (path === "/api/settings/logo" || /^\/posts\/[^/]+\/images$/.test(path))
  );
}

/**
 * The most a request may declare before Kestrel reads it. The real caps are enforced as the
 * bytes are stored (src/media.ts); this only keeps an oversized body from being buffered,
 * allowing for a multipart envelope around an object at the cap.
 */
const MAX_UPLOAD_REQUEST_BYTES = MAX_OBJECT_BYTES + 256 * 1024;

export class SandboxDO extends DurableObject<Env> {
  readonly db = new DurableObjectD1(this.ctx.storage);
  readonly media = new SandboxMedia(
    this.env.MEDIA,
    this.ctx.storage.sql,
    `sessions/${this.ctx.id.toString()}/`,
    `seed/${BUILD_INFO.tag}/`,
  );
  private readonly kenv: KestrelEnv = sandboxEnv(this.env, this.db.asD1(), this.media.asR2());
  /** The seed's env: the same, but with the only media view that writes the shared seed
   *  images. Never handed to a request handler. */
  private readonly seedEnv: KestrelEnv = { ...this.kenv, MEDIA: this.media.seedView() };
  private starting: Promise<void> | undefined;

  /**
   * Migrate and seed, once per DO start, before anything else runs. The promise is shared,
   * so concurrent first requests within one event wait on the same start, and
   * blockConcurrencyWhile holds every other event until it's done, so none sees a
   * half-seeded database. A start that throws is forgotten, so the next request retries it.
   * Done on first fetch rather than in the constructor, so a DO opened only to inspect its
   * storage (the tests' runInDurableObject) isn't seeded behind their back.
   */
  private start(): Promise<void> {
    this.starting ??= this.ctx
      .blockConcurrencyWhile(async () => {
        migrate(this.ctx.storage, migrations);
        // A re-seed first clears the sandbox's own uploads, which Kestrel's resetAll can't.
        await ensureSeeded(this.seedEnv, BUILD_INFO.tag, () => this.media.clear());
      })
      .catch((err: unknown) => {
        this.starting = undefined;
        throw err;
      });
    return this.starting;
  }

  async fetch(request: Request): Promise<Response> {
    await this.start();
    const path = new URL(request.url).pathname;
    if (isUpload(request, path)) {
      const declared = Number(request.headers.get("content-length") ?? Number.NaN);
      if (!Number.isFinite(declared)) {
        return Response.json(
          { error: "length_required", message: "an upload must declare its Content-Length" },
          { status: 411 },
        );
      }
      if (declared > MAX_UPLOAD_REQUEST_BYTES) {
        return Response.json(
          {
            error: "upload_too_large",
            message: `an upload must be ${MAX_OBJECT_BYTES / 1024 / 1024} MB or smaller`,
          },
          { status: 413 },
        );
      }
    }
    // The Worker makes every sandbox response private (src/index.ts), media included: the
    // same /media URL names different bytes in different sandboxes.
    return kestrel.fetch(request, this.kenv, this.executionContext());
  }

  /** What Kestrel's handler expects as its `ExecutionContext`, from the DO's own state. */
  private executionContext(): ExecutionContext {
    return {
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      passThroughOnException: () => {},
      props: {},
    } as ExecutionContext;
  }
}
