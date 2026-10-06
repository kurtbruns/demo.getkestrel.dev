// Static assets are served before the Worker runs, so their noindex comes from the _headers
// file in the built tree (patches/0003-demo-noindex.patch). The Worker suite can't see the
// assets layer, so this checks the built file itself. Run after `npm run build`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the built assets' _headers marks every asset noindex", () => {
  const headers = readFileSync(
    fileURLToPath(new URL("../../vendor/kestrel/dist/public/_headers", import.meta.url)),
    "utf8",
  );
  assert.match(headers, /^\/\*\n\s+X-Robots-Tag: noindex$/m);
});
