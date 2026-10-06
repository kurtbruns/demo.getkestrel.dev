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

describe("the public pages", () => {
  it("carry the demo pill, opening the dashboard, and no form to the reset", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { slug: string }[] }>("/posts?status=sent");
    const slug = body.posts[0]?.slug;
    expect(slug).toBeDefined();
    const pages = [
      "/", // the landing page (reader shell)
      "/archive", // the archive index (reader shell)
      `/archive/${slug}`, // a hosted post page (injected chrome; form-action 'none')
      "/subscribe", // a reader-shell form
      "/unsubscribe?token=nope", // a card page
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
      expect(html, path).toContain("Your own copy of Kestrel");
      // The reset lives in the dashboard: no public page links to it or carries its form.
      expect(html, path).not.toContain(RESET_PATH);
      // It opens with no script, which these pages forbid.
      expect(html, path).toMatch(/<aside class="r-demo"[^>]*><details><summary>/);
      expect(res.headers.get("content-security-policy"), path).toContain("script-src 'none'");
    }
  });

  it("don't carry it into the email: not the preview, the frozen send, or what was sent", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { id: string }[] }>("/posts?status=draft");
    const preview = await v.fetch(`/posts/${body.posts[0]?.id}/preview`);
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
    const res = await v.fetch("/posts");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain(PILL);
  });
});

describe("the reset route", () => {
  it("answers a GET with the dashboard, where the reset step lives", async () => {
    const v = visitor();
    await v.fetch("/posts");
    const res = await v.fetch(RESET_PATH, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("takes what the dashboard's form posts: a same-origin form submit, answered with the editor", async () => {
    const v = visitor();
    await v.fetch("/posts");
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
