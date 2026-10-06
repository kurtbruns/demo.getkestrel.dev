/**
 * One visitor's sandbox: a SQLite-backed Durable Object whose storage is that visitor's
 * Kestrel database, through the D1 adapter (DESIGN.md, "Architecture"). The Worker routes
 * every request the visitor makes here, by their session cookie (src/session.ts).
 */

import { DurableObject } from "cloudflare:workers";
import kestrel, { BUILD_INFO, type KestrelEnv, migrations } from "kestrel";
import { DurableObjectD1 } from "./d1/adapter";
import { migrate } from "./d1/migrate";
import { ensureSeeded, sandboxEnv } from "./sandbox";

export class SandboxDO extends DurableObject<Env> {
  readonly db = new DurableObjectD1(this.ctx.storage);
  private readonly kenv: KestrelEnv = sandboxEnv(this.env, this.db.asD1());
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
        await ensureSeeded(this.kenv, BUILD_INFO.tag);
      })
      .catch((err: unknown) => {
        this.starting = undefined;
        throw err;
      });
    return this.starting;
  }

  async fetch(request: Request): Promise<Response> {
    await this.start();
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
