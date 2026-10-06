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

/** How long a sandbox outlives its visitor's last request before it's deleted (#8). */
export const IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** How long after a failed wipe the alarm tries again. */
const WIPE_RETRY_MS = 5 * 60 * 1000;

/** `last_seen` is rewritten at most this often, so a busy visitor isn't two writes a request. */
const TOUCH_EVERY_MS = 60 * 1000;

/** The visitor's "Reset demo" control posts here (#9's banner). */
export const RESET_PATH = "/_demo/reset";

/**
 * The confirmation step every "Reset demo" link leads to (patches/0004-demo-chrome.patch):
 * a page of the demo's own, so its form can post here whatever the linking page's policy
 * (Kestrel's post pages forbid form posts, and its public pages forbid script, so neither
 * can confirm a reset itself). The button is the reset; "Keep my changes" goes back.
 */
function resetConfirmPage(): Response {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Reset the Kestrel demo?</title>
<style>
:root { color-scheme: light dark; --bg:#f8f8f8; --card:#fff; --ink:#18181b; --mut:#52525b; --line:#e4e4e7; --accent:#3355cc; --on:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#18181b; --card:#232327; --ink:#e5e7eb; --mut:#a1a1aa; --line:#2e2e33; --accent:#7d9bff; --on:#10131f; } }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
main { max-width:34rem; margin:12vh auto; padding:28px; background:var(--card); border:1px solid var(--line); border-radius:12px; }
h1 { font-size:1.35rem; margin:0 0 10px; }
p { color:var(--mut); margin:0 0 22px; }
.row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
form { margin:0; }
button { font:inherit; font-weight:600; cursor:pointer; padding:9px 18px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:var(--on); }
a { color:var(--accent); font-weight:600; text-decoration:none; }
button:focus-visible, a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (max-width: 600px) { main { margin:16px; } }
</style></head>
<body><main>
<h1>Reset the demo?</h1>
<p>Everything you've changed in this sandbox (posts, subscribers, settings, sends and uploads) is discarded, and the sample publication is restored.</p>
<div class="row"><form method="post" action="${RESET_PATH}"><button type="submit">Reset demo</button></form><a href="/dashboard/">Keep my changes</a></div>
</main></body></html>
`;
  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Whether a write comes from the demo's own pages: a browser says so in Sec-Fetch-Site
 * (which a page can't forge), or, lacking it, sends an Origin that matches. A client that
 * isn't a browser sends neither and passes, as Kestrel's own admin gate does.
 */
function isOwnWrite(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    return site === "same-origin" || site === "none";
  }
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
}

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
        // Seeded by another Kestrel release: start over rather than migrate in place
        // (DESIGN.md, "Updating the demo"). Sandboxes are disposable; a fresh one is correct.
        const seededBy = this.meta("seeded_kestrel");
        if (seededBy !== null && seededBy !== BUILD_INFO.tag) {
          await this.wipe();
        }
        this.media.init();
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
    // The visitor is here: stamped before the request runs, so an expiry alarm delivered
    // while it awaits I/O sees a visitor, not an idle sandbox to wipe.
    this.touch();
    try {
      return await this.handle(request);
    } finally {
      // Any request may have scheduled, moved or canceled a send. A failure here is logged,
      // never thrown over the request's own result or error.
      await Promise.resolve()
        .then(() => {
          this.touch();
          return this.armAlarm();
        })
        .catch((err: unknown) => {
          // biome-ignore lint/suspicious/noConsole: the sandbox's only log line for this.
          console.error("demo.alarm_arm_failed", err);
        });
    }
  }

  /**
   * The one alarm does both jobs: delete the sandbox once its visitor has been gone the idle
   * TTL, and otherwise run Kestrel's send sweep, then arm the next wake. A tick that fails is
   * logged, as Kestrel's own cron would, and the next tick comes from `armAlarm`, not the
   * runtime's alarm retries.
   */
  async alarm(): Promise<void> {
    const lastSeen = Number(this.meta("last_seen") ?? Number.NaN);
    const seededBy = this.meta("seeded_kestrel");
    if (seededBy === null) {
      // Nothing here: wiped, or never used.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Expired, or seeded by another Kestrel release (which a request would wipe and seed
    // again): wipe it here, and never seed from an alarm. The visitor's next request, if
    // any, starts it fresh.
    if (
      seededBy !== BUILD_INFO.tag ||
      (Number.isFinite(lastSeen) && Date.now() >= lastSeen + IDLE_TTL_MS)
    ) {
      // Caught inside: a blockConcurrencyWhile callback that throws resets the object.
      await this.ctx.blockConcurrencyWhile(async () => {
        try {
          await this.wipe();
          this.starting = undefined;
        } catch (err) {
          // Try again later rather than rely on the runtime's few retries, after which a
          // sandbox would never expire.
          // biome-ignore lint/suspicious/noConsole: the sandbox's only log line for this.
          console.error("demo.wipe_failed", err);
          await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
        }
      });
      return;
    }
    if (!Number.isFinite(lastSeen)) {
      this.touch(); // a seeded sandbox always has an expiry
    }
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

  /**
   * Delete everything this sandbox holds: its uploads in R2 (not the shared seed images),
   * its whole SQLite database, and its alarm. The next request starts it fresh.
   */
  private async wipe(): Promise<void> {
    this.media.init();
    await this.media.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** "Reset demo": wipe the sandbox and seed it again, then back to the editor. */
  private async reset(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET") {
      return resetConfirmPage();
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { allow: "GET, POST" } },
      );
    }
    if (!isOwnWrite(request, url)) {
      return Response.json(
        { error: "cross_site_request", message: "a page on another site can't reset this demo" },
        { status: 403 },
      );
    }
    await this.ctx.blockConcurrencyWhile(() => this.wipe());
    this.starting = undefined;
    await this.start();
    return new Response(null, { status: 303, headers: { location: "/dashboard/" } });
  }

  /** Record the visitor's activity, which pushes the idle expiry out (at most once a minute). */
  private touch(): void {
    const now = Date.now();
    const seen = Number(this.meta("last_seen") ?? Number.NaN);
    if (!Number.isFinite(seen) || now - seen >= TOUCH_EVERY_MS) {
      this.setMeta("last_seen", String(now));
    }
  }

  /** A value in the demo's own `demo_meta` table, or null (also before it exists). */
  private meta(key: string): string | null {
    const table = this.ctx.storage.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_meta'")
      .toArray();
    if (table.length === 0) {
      return null;
    }
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM demo_meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO demo_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
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
   * next work (a tick from now while a send is in flight, the earliest scheduled send's fire
   * time) and the idle expiry (the TTL after the visitor's last request). Every reason to wake is a term here, so the one alarm always serves
   * the soonest. Reads Kestrel's `sends` table directly (read-only).
   */
  private nextWake(now: number): number | null {
    const sql = this.ctx.storage.sql;
    const seen = Number(this.meta("last_seen") ?? Number.NaN);
    const lastSeen = Number.isFinite(seen) ? seen : null;
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
      lastSeen !== null ? lastSeen + IDLE_TTL_MS : null,
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
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === RESET_PATH) {
      return this.reset(request, url);
    }
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
