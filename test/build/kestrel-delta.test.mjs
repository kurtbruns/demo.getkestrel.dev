// scripts/kestrel-delta.mjs, against the real Kestrel repo: nothing to report at the latest
// release, and a rehearsal across a release that reports the changelog and flags a patch
// that no longer applies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "kestrel-delta-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function delta(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/kestrel-delta.mjs", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("reports nothing to do when the pin is the latest release", () => {
  const r = delta(["--to", "v1.2.0", "--from", "v1.2.0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to update/);
});

test("a rehearsal across a release reports the changelog and flags a patch that won't apply", () => {
  // This repo's patches, plus one that edits a line Kestrel doesn't have.
  for (const f of readdirSync("patches").filter((f) => f.endsWith(".patch"))) {
    copyFileSync(join("patches", f), join(scratch, f));
  }
  writeFileSync(
    join(scratch, "0099-broken.patch"),
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-No such line.\n+Nor this.\n",
  );
  const r = delta(["--from", "v1.1.0", "--to", "v1.2.0"], { KESTREL_PATCHES_DIR: scratch });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Kestrel v1\.1\.0 → v1\.2\.0/m);
  assert.match(r.stdout, /^### \[1\.2\.0\]/m);
  assert.match(r.stdout, /\| `0001-demo-auth\.patch` \| yes \|/);
  assert.match(r.stdout, /\| `0099-broken\.patch` \| \*\*no\*\*/);
});
