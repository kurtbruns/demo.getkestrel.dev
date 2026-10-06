// The demo chrome (patches/0004-demo-chrome.patch): every public page says it's a private,
// temporary sandbox and links to the editor and the reset; the reset's confirmation page
// can post where the linking page couldn't; the email itself never carries any of it; and
// Kestrel's JSON API is untouched. The editor side (the banner, the "Demo sandbox" chip)
// is covered by the patch's own client spec, run on the patched tree.

import { runInDurableObject } from "cloudflare:test";
import { fakeOutbox } from "kestrel";
import { describe, expect, it } from "vitest";
import { RESET_PATH } from "../src/sandbox_do";
import { publish, visitor } from "./support";

const BANNER = 'class="d-demo"';

/** The form-action sources a page's CSP allows, or null when it sets none. */
function formAction(res: Response): string | null {
  const csp = res.headers.get("content-security-policy") ?? "";
  return /form-action ([^;]+)/.exec(csp)?.[1]?.trim() ?? null;
}

describe("the public pages", () => {
  it("carry the sandbox banner, with the editor and the reset", async () => {
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
      expect(html, path).toContain(BANNER);
      expect(html, path).toContain('href="/dashboard/"');
      expect(html, path).toContain(`href="${RESET_PATH}"`);
      // Any page that does carry a form to the reset must be allowed to submit it.
      if (html.includes(`action="${RESET_PATH}"`)) {
        expect(formAction(res), path).toMatch(/'self'/);
      }
    }
  });

  it("don't carry it into the email: not the preview, the frozen send, or what was sent", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { id: string }[] }>("/posts?status=draft");
    const preview = await v.fetch(`/posts/${body.posts[0]?.id}/preview`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).not.toContain(BANNER);
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
    expect(frozen.rendered_html).not.toContain(BANNER);
    const sent = fakeOutbox().filter((m) => (m as { subject?: string }).subject === subject);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect((m as { html: string }).html).not.toContain(BANNER);
    }
  });

  it("leave Kestrel's JSON API as it was", async () => {
    const v = visitor();
    const res = await v.fetch("/posts");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain(BANNER);
  });
});

describe("the reset's confirmation page", () => {
  it("asks first, and its form may post the reset", async () => {
    const v = visitor();
    await v.fetch("/posts");
    const page = await v.fetch(RESET_PATH);
    expect(page.status).toBe(200);
    expect(formAction(page)).toBe("'self'");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    const html = await page.text();
    expect(html).toContain("Reset the demo?");
    expect(html).toContain(`<form method="post" action="${RESET_PATH}">`);
    expect(html).toContain('href="/dashboard/"'); // keep my changes
  });

  it("posts what the route takes: a same-origin form submit, answered with the editor", async () => {
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
