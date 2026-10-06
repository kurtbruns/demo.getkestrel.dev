// The demo chrome (patches/0004-demo-chrome.patch): every public page says it's a private,
// temporary sandbox and offers the editor and the reset; the email itself never carries it;
// and Kestrel's JSON API is untouched. The editor side (the banner, the "Demo sandbox" chip)
// is covered by the patch's own client spec, run on the patched tree.

import { describe, expect, it } from "vitest";
import { RESET_PATH } from "../src/sandbox_do";
import { visitor } from "./support";

const BANNER = 'class="d-demo"';

describe("the public pages", () => {
  it("carry the sandbox banner, with the editor link and the reset form", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { slug: string; id: string }[] }>("/posts?status=sent");
    const pages = [
      "/", // the landing page (reader shell)
      "/archive", // the archive index (reader shell)
      `/archive/${body.posts[0]?.slug}`, // a hosted post page (injected chrome)
      "/subscribe", // a reader-shell form
      "/unsubscribe?token=nope", // a card page
    ];
    for (const path of pages) {
      const res = await v.fetch(path);
      const html = await res.text();
      expect(html, path).toContain(BANNER);
      expect(html, path).toContain('href="/dashboard/"');
      expect(html, path).toContain(`action="${RESET_PATH}"`);
    }
  });

  it("don't carry it into the email: the preview is the email as sent", async () => {
    const v = visitor();
    const { body } = await v.json<{ posts: { id: string }[] }>("/posts?status=draft");
    const res = await v.fetch(`/posts/${body.posts[0]?.id}/preview`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(BANNER);
    expect(html).not.toContain(RESET_PATH);
  });

  it("leave Kestrel's JSON API as it was", async () => {
    const v = visitor();
    const res = await v.fetch("/posts");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain(BANNER);
  });
});

describe("the reset form", () => {
  it("is the same-origin POST the demo's reset route takes", async () => {
    const v = visitor();
    const page = await (await v.fetch("/")).text();
    expect(page).toMatch(new RegExp(`<form method="post" action="${RESET_PATH}">`));
    // What a browser sends when the visitor clicks it.
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
