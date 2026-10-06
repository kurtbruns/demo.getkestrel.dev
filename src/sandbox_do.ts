/**
 * One visitor's sandbox: a SQLite-backed Durable Object whose storage is that visitor's
 * Kestrel database (through the D1 adapter). #4 routes requests here and bootstraps it; for
 * now it only exists so the adapter runs against real DO SQLite.
 */

import { DurableObject } from "cloudflare:workers";
import { DurableObjectD1 } from "./d1/adapter";

export class SandboxDO extends DurableObject<Env> {
  readonly db = new DurableObjectD1(this.ctx.storage);

  fetch(): Response {
    return new Response("Not routed yet (#4)", { status: 501 });
  }
}
