/**
 * One visitor's sandbox: a SQLite-backed Durable Object whose storage is that visitor's
 * Kestrel database, through the D1 adapter (DESIGN.md, "Architecture"). The Worker routes
 * every request the visitor makes here, by their session cookie (src/session.ts), and the
 * DO's alarm runs Kestrel's send sweep for this sandbox alone (DESIGN.md, "Sends").
 */

import { DurableObject } from "cloudflare:workers";
import kestrel, { BUILD_INFO, type KestrelEnv, migrations } from "kestrel";
import { DurableObjectD1 } from "./d1/adapter";
import { migrate } from "./d1/migrate";
import { egress } from "./egress";
import { MAX_OBJECT_BYTES, SandboxMedia } from "./media";
import { checkSandboxConfig, ensureSeeded, sandboxEnv } from "./sandbox";

/** Kestrel's sweep runs once a minute; a send in flight is swept again a tick later. */
const SWEEP_TICK_MS = 60_000;

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
        checkSandboxConfig(this.kenv);
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
    try {
      return await this.handle(request);
    } finally {
      // Any request may have scheduled, moved or canceled a send. A failure here is logged,
      // never thrown over the request's own result or error.
      await this.armAlarm().catch((err: unknown) => {
        // biome-ignore lint/suspicious/noConsole: the sandbox's only log line for this.
        console.error("demo.alarm_arm_failed", err);
      });
    }
  }

  /**
   * Run Kestrel's send sweep for this sandbox, then arm the next one. A tick that fails is
   * logged, as Kestrel's own cron would, and the next tick comes from `armAlarm`, not the
   * runtime's alarm retries.
   */
  async alarm(): Promise<void> {
    await this.start();
    try {
      await this.sweep();
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: the sandbox's only log line for a failed tick.
      console.error("demo.sweep_failed", err);
    } finally {
      await this.armAlarm();
    }
  }

  /** Requests refused by the egress block in this isolate (src/egress.ts), for the tests. */
  egressRefused(): number {
    return egress.refused;
  }

  /** Kestrel's own scheduled handler, as its once-a-minute Cron Trigger would call it. */
  private async sweep(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const controller = {
      cron: "* * * * *",
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as ScheduledController;
    await kestrel.scheduled(controller, this.kenv, {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    } as ExecutionContext);
    // The sweep runs under waitUntil; the alarm is done when it is.
    await Promise.all(pending);
  }

  /**
   * When the sandbox next needs to wake, or null for never: the earliest of the sweep's
   * next work, a tick from now while a send is in flight and the earliest scheduled send's
   * fire time otherwise. Every reason to wake is a term here, so the one alarm always serves
   * the soonest. Reads Kestrel's `sends` table directly (read-only).
   */
  private nextWake(now: number): number | null {
    const sql = this.ctx.storage.sql;
    const sending = sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM sends WHERE status = 'sending'")
      .one().n;
    const firstDue = sql
      .exec<{ at: number | null }>(
        "SELECT min(fire_at) AS at FROM sends WHERE status = 'scheduled'",
      )
      .one().at;
    const times = [
      sending > 0 ? now + SWEEP_TICK_MS : null,
      firstDue !== null ? Math.max(firstDue, now + 1000) : null,
    ].filter((t): t is number => t !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** Set the alarm to `nextWake`, or clear it. A sandbox with nothing to do never wakes. */
  private async armAlarm(): Promise<void> {
    const next = this.nextWake(Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) {
        await this.ctx.storage.deleteAlarm();
      }
    } else if (current !== next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async handle(request: Request): Promise<Response> {
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
