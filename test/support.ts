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

/**
 * Publish a new post in `v`'s sandbox the way the editor would (create, schedule at the
 * minimum lead), then let its fire time pass and run the sandbox's sweep alarm, so it lands
 * in that sandbox's public archive. Returns its slug.
 */
export async function publish(
  v: Visitor,
  post: { subject: string; slug: string; markdown: string },
): Promise<string> {
  const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test");
  if (!v.cookie) {
    await v.fetch("/api/posts"); // a session starts with a GET, as the editor's does
  }
  const created = await v.json<{ post: { id: string; slug: string } }>("/api/posts", {
    method: "POST",
    headers: SAME_ORIGIN,
    body: JSON.stringify(post),
  });
  if (created.status !== 201) {
    throw new Error(`create failed: ${created.status}`);
  }
  const scheduled = await v.json<{ send: { id: string } }>(
    `/api/posts/${created.body.post.id}/schedule`,
    {
      method: "POST",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ fire_at: Date.now() + 61_000 }),
    },
  );
  if (scheduled.status !== 201) {
    throw new Error(`schedule failed: ${scheduled.status}`);
  }
  const stub = await v.sandbox();
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(
      "UPDATE sends SET fire_at = ? WHERE id = ?",
      Date.now() - 1000,
      scheduled.body.send.id,
    );
  });
  await runDurableObjectAlarm(stub);
  return created.body.post.slug;
}

/**
 * Start sessions from one IP until the new-session rate limit refuses one (at most 25
 * tries), returning every status and the refusal. The limiter counts in fixed one-minute
 * windows, so a burst that straddles a window's end gets a fresh allowance partway; 25 is
 * enough to reach a refusal even then.
 */
export async function exhaustNewSessions(
  ip: string,
): Promise<{ statuses: number[]; refused: Response | undefined }> {
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) {
    const res = await SELF.fetch(`${BASE}/api/whoami`, { headers: { "cf-connecting-ip": ip } });
    statuses.push(res.status);
    if (res.status === 429) {
      return { statuses, refused: res };
    }
    await res.arrayBuffer();
  }
  return { statuses, refused: undefined };
}

/** Save `fields` to post `id` as the editor does, naming the revision it read (Kestrel
 *  refuses a save without one, 428 `base_required`, since v1.5.0). */
export async function savePost(
  v: Visitor,
  id: string,
  fields: Record<string, unknown>,
): Promise<Response> {
  const { body } = await v.json<{ post: { current_revision: string } }>(`/api/posts/${id}`);
  return v.fetch(`/api/posts/${id}`, {
    method: "PUT",
    headers: SAME_ORIGIN,
    body: JSON.stringify({ ...fields, base_revision: body.post.current_revision }),
  });
}

/** A row of Kestrel's list export (`kestrel-subscribers/1`), as far as the tests read it. */
export interface ExportedRow {
  email: string;
  status: string;
  origin: string;
}

/**
 * Import `file` into `v`'s sandbox as the editor does (since v1.9.0): plan it, then commit
 * the plan with the attestation and every growing send acknowledged, as a person may.
 * Returns the plan's counts and the commit's status.
 */
export async function importList(
  v: Visitor,
  file: { name: string; text: string },
): Promise<{ counts: Record<string, number>; status: number }> {
  const plan = await v.json<{
    counts: Record<string, number>;
    plan_hash: string;
    attestation: { version: number } | null;
    sends_growing: { id: string }[];
  }>("/api/imports/plan", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ file }) });
  if (plan.status !== 200) {
    throw new Error(`the import plan answered ${plan.status}`);
  }
  const commit = await v.fetch("/api/imports", {
    method: "POST",
    headers: SAME_ORIGIN,
    body: JSON.stringify({
      file,
      plan_hash: plan.body.plan_hash,
      ...(plan.body.attestation
        ? { attestation: { version: plan.body.attestation.version, accepted: true } }
        : {}),
      acknowledge_sends: plan.body.sends_growing.map((s) => s.id),
    }),
  });
  await commit.arrayBuffer();
  return { counts: plan.body.counts, status: commit.status };
}

/** Read `v`'s whole list through the export, following `next` to the end (at the sandbox's
 *  10,000-row pages, the seed's list is one page, so `next` is null at once). */
export async function exportList(v: Visitor): Promise<ExportedRow[]> {
  const rows: ExportedRow[] = [];
  let after: string | null = null;
  do {
    const query: string = after ? `?after=${encodeURIComponent(after)}` : "";
    const page = await v.json<{ subscribers: ExportedRow[]; next: string | null }>(
      `/api/subscribers/export${query}`,
    );
    if (page.status !== 200) {
      throw new Error(`the export answered ${page.status}`);
    }
    rows.push(...page.body.subscribers);
    after = page.body.next;
  } while (after);
  return rows;
}
