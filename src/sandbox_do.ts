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
  private ready = false;

  async fetch(request: Request): Promise<Response> {
    if (!this.ready) {
      // The first request migrates and seeds. blockConcurrencyWhile holds every other event
      // until it's done, so concurrent first requests seed once and none sees a half-seeded
      // database. Done on first fetch rather than in the constructor, so a DO opened only to
      // inspect its storage (the tests' runInDurableObject) isn't seeded behind their back.
      await this.ctx.blockConcurrencyWhile(async () => {
        if (!this.ready) {
          migrate(this.ctx.storage, migrations);
          await ensureSeeded(this.kenv, BUILD_INFO.tag);
          this.ready = true;
        }
      });
    }
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
