// The patch step of scripts/fetch-kestrel.mjs, against a real clone of the pinned tag in a
// scratch directory: a patch that applies is applied, and one that doesn't stops the build,
// names the patch, and leaves no tree or build record behind.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "fetch-kestrel-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the script with --apply-only into a fresh scratch tree, with the given patches. */
function applyOnly(name, patches) {
  const base = join(scratch, name);
  const patchDir = join(base, "patches");
  mkdirSync(patchDir, { recursive: true });
  for (const [file, body] of Object.entries(patches)) {
    writeFileSync(join(patchDir, file), body);
  }
  const vendor = join(base, "vendor", "kestrel");
  const result = spawnSync(process.execPath, ["scripts/fetch-kestrel.mjs", "--apply-only"], {
    encoding: "utf8",
    env: { ...process.env, KESTREL_VENDOR_DIR: vendor, KESTREL_PATCHES_DIR: patchDir },
  });
  return { ...result, vendor, record: join(base, "vendor", ".kestrel-build.json") };
}

// Adds a file, so it applies to any tree.
const GOOD = `Header comment: git apply ignores everything above the first diff.

diff --git a/DEMO_PATCH_TEST b/DEMO_PATCH_TEST
new file mode 100644
--- /dev/null
+++ b/DEMO_PATCH_TEST
@@ -0,0 +1 @@
+patched
`;

// Changes a line Kestrel's README doesn't have.
const BAD = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-This line is not in Kestrel's README.
+Neither is this one.
`;

test("a patch that applies is applied to the clone", () => {
  const r = applyOnly("good", { "0001-good.patch": GOOD });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /applied .*0001-good\.patch/);
  assert.equal(readFileSync(join(r.vendor, "DEMO_PATCH_TEST"), "utf8"), "patched\n");
  assert.equal(existsSync(r.record), false, "--apply-only writes no build record");
});

test("a patch that doesn't apply stops the build, names it, and leaves nothing behind", () => {
  const r = applyOnly("bad", { "0001-good.patch": GOOD, "0002-bad.patch": BAD });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /0002-bad\.patch does not apply to Kestrel v\d+\.\d+\.\d+/);
  assert.equal(existsSync(r.vendor), false, "no half-patched tree is left");
  assert.equal(existsSync(r.record), false, "no build record is left");
});
