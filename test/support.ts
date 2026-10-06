// A test visitor: a browser stand-in that keeps the session cookie the Worker sets and
// comes from its own IP, so tests share neither a sandbox nor a rate-limit bucket unless
// they mean to.

import { env, SELF } from "cloudflare:test";
import type { SandboxDO } from "../src/sandbox_do";
import { SESSION_COOKIE, sandboxName } from "../src/session";

export const BASE = "https://demo.getkestrel.dev";

let ips = 0;

export interface Visitor {
  readonly ip: string;
  /** The `name=value` of the session cookie, once the Worker has set one. */
  cookie: string | undefined;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** This visitor's sandbox Durable Object, for inspecting its storage. */
  sandbox(): Promise<DurableObjectStub<SandboxDO>>;
}

export function visitor(ip = `198.51.100.${++ips}`): Visitor {
  const v: Visitor = {
    ip,
    cookie: undefined,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", ip);
      if (v.cookie) {
        headers.set("cookie", v.cookie);
      }
      const res = await SELF.fetch(`${BASE}${path}`, { ...init, headers });
      const set = res.headers.get("set-cookie");
      if (set) {
        v.cookie = set.split(";")[0];
      }
      return res;
    },
    async json<T>(path: string, init?: RequestInit) {
      const res = await v.fetch(path, init);
      return { status: res.status, body: (await res.json()) as T };
    },
    async sandbox() {
      const token = v.cookie?.slice(`${SESSION_COOKIE}=`.length).split(".")[0];
      if (!token) {
        throw new Error("this visitor has no session yet");
      }
      const secret = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
      return env.SANDBOX.get(env.SANDBOX.idFromName(await sandboxName(secret, token)));
    },
  };
  return v;
}

/** Headers for a write the editor itself would send. */
export const SAME_ORIGIN = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
