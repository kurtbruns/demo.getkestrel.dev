// The demo chrome (patches/0004-demo-chrome.patch): every public page carries the demo
// pill, which says it's a private, temporary sandbox and links to the editor, with no form
// (the reset lives in the editor only); a GET of the reset lands on the editor; the email
// itself never carries any of it; and Kestrel's JSON API is untouched. The editor side
// (its pill with the reset step, the "Demo sandbox" chip) is covered by the patch's own
// client spec, run on the patched tree.

import { runInDurableObject } from "cloudflare:test";
import { fakeOutbox } from "kestrel";
import { describe, expect, it } from "vitest";
import { RESET_PATH } from "../src/sandbox_do";
import { publish, visitor } from "./support";

const PILL = 'class="r-demo"';

/** What a browser's navigation asks for. Since Kestrel 1.22.0 an address that names no page
 *  answers it with a page, and anything that doesn't ask for one with JSON. */
const BROWSER = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

describe("the public pages", () => {
  it("carry the demo pill, opening the dashboard, and no form to the reset", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { slug: string }[] }>("/api/posts?status=sent");
    const slug = body.posts[0]?.slug;
    expect(slug).toBeDefined();
    const pages = [
      "/", // the landing page (reader shell)
      "/archive", // the archive index (reader shell)
      `/archive/${slug}`, // a hosted post page (injected chrome; form-action 'none')
      "/subscribe", // a reader-shell form
      "/unsubscribe?token=nope", // a message page (reader shell)
    ];
    for (const path of pages) {
      const res = await v.fetch(path);
      const html = await res.text();
      expect(html, path).toContain(PILL);
      // Exactly one pill, and no strip left over from the banner it replaced.
      expect(html.split(PILL).length - 1, path).toBe(1);
      expect(html, path).not.toContain("d-demo");
      expect(html, path).toMatch(
        /<a class="r-demo-go" href="\/dashboard\/">Open dashboard &rarr;<\/a>/,
      );
      expect(html, path).toContain("Kestrel demo sandbox");
      // The reset lives in the dashboard: no public page links to it or carries its form.
      expect(html, path).not.toContain(RESET_PATH);
      // It opens with no script, which these pages forbid.
      expect(html, path).toMatch(/<aside class="r-demo"[^>]*><details><summary>/);
      expect(res.headers.get("content-security-policy"), path).toContain("script-src 'none'");
      // Since Kestrel 1.21.0, and through the Worker, so a token in the URL stays out of a
      // Referer.
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
    }
  });

  it("carry it on the page a browser gets at an address with no page, kept by no shared cache", async () => {
    const first = visitor();
    const opening = await first.fetch("/no-such-page", { headers: BROWSER });
    // A first visit can land here, so the page is what starts the session.
    expect(opening.headers.get("set-cookie")).not.toBeNull();
    expect(opening.headers.get("cache-control")).toBe("private, no-store");
    await opening.arrayBuffer();

    const v = visitor();
    await v.fetch("/api/posts");
    // A mistyped address, an image that isn't there, and a key the sandbox's media refuses.
    for (const path of ["/no-such-page", "/media/none.png", "/media/"]) {
      const res = await v.fetch(path, { headers: BROWSER });
      const html = await res.text();
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(html, path).toContain("No page here");
      expect(html.split(PILL).length - 1, path).toBe(1);
      expect(html, path).toMatch(
        /<a class="r-demo-go" href="\/dashboard\/">Open dashboard &rarr;<\/a>/,
      );
      expect(html, path).not.toContain(RESET_PATH);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(res.headers.get("cache-control"), path).toBe("private, no-cache");
      expect(res.headers.get("vary"), path).toContain("Cookie");
      expect(res.headers.get("content-security-policy"), path).toContain("script-src 'none'");
    }
  });

  it("carry it at a trailing slash too, the same page as without one", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { slug: string; email_only: boolean }[] }>(
      "/api/posts?status=sent",
    );
    const slug = body.posts.find((p) => !p.email_only)?.slug;
    expect(slug).toBeDefined();
    for (const path of ["/archive", `/archive/${slug}`, "/subscribe"]) {
      const bare = await v.fetch(path, { headers: BROWSER });
      const slashed = await v.fetch(`${path}/`, { headers: BROWSER });
      expect(slashed.status, path).toBe(200);
      const html = await slashed.text();
      expect(html, path).toContain(PILL);
      expect(html, path).toBe(await bare.text());
      expect(slashed.headers.get("x-robots-tag"), path).toBe("noindex");
    }
  });

  it("take a reader's form post, which says Origin: null from a no-referrer page", async () => {
    const v = visitor();
    await v.fetch("/subscribe");
    const res = await v.fetch("/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ email: `reader-${crypto.randomUUID()}@example.com` }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("inbox");
  });

  it("don't carry it into the email: not the preview, the frozen send, or what was sent", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { id: string }[] }>("/api/posts?status=draft");
    const preview = await v.fetch(`/api/posts/${body.posts[0]?.id}/preview`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).not.toContain(PILL);
    expect(html).not.toContain(RESET_PATH);

    const subject = `Chrome check ${crypto.randomUUID()}`;
    await publish(v, { subject, slug: `chrome-${crypto.randomUUID()}`, markdown: "Body." });
    const frozen = await runInDurableObject(await v.sandbox(), (_i, state) =>
      state.storage.sql
        .exec<{ rendered_html: string }>(
          "SELECT rendered_html FROM sends WHERE subject = ?",
          subject,
        )
        .one(),
    );
    expect(frozen.rendered_html).not.toContain(PILL);
    const sent = fakeOutbox().filter((m) => m.subject === subject);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.html).not.toContain(PILL);
    }
  });

  it("leave Kestrel's JSON API as it was", async () => {
    const v = visitor();
    const res = await v.fetch("/api/posts");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain(PILL);
    // An /api path is JSON even to a browser, and so is an address that doesn't ask for a page.
    for (const [path, headers] of [
      ["/api/no-such-route", BROWSER],
      ["/no-such-page", {}],
    ] as const) {
      const refused = await v.fetch(path, { headers });
      expect(refused.status, path).toBe(404);
      expect(refused.headers.get("content-type"), path).toContain("application/json");
      expect(await refused.text(), path).not.toContain(PILL);
    }
  });
});

describe("the reset route", () => {
  it("answers a GET with the dashboard, where the reset step lives", async () => {
    const v = visitor();
    await v.fetch("/api/posts");
    const res = await v.fetch(RESET_PATH, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("starts no sandbox for a cookieless GET or HEAD", async () => {
    for (const method of ["GET", "HEAD"]) {
      const v = visitor();
      const res = await v.fetch(RESET_PATH, { method, redirect: "manual" });
      expect(res.status, method).toBe(303);
      expect(res.headers.get("location"), method).toBe("/dashboard/");
      expect(res.headers.get("set-cookie"), method).toBeNull();
      expect(v.cookie, method).toBeUndefined();
    }
  });

  it("takes what the dashboard's form posts: a same-origin form submit, answered with the editor", async () => {
    const v = visitor();
    await v.fetch("/api/posts");
    const res = await v.fetch(RESET_PATH, {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard/");
  });
});
