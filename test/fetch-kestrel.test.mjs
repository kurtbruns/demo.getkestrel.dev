// scripts/fetch-kestrel.mjs against a real clone of the pinned tag in a scratch directory: a
// patch that applies is applied; one that doesn't stops the build, names the patch, and
// leaves no tree or build record behind; an authoring session isn't wiped by a later build;
// and the tree can never be the repo itself.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "fetch-kestrel-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the script with `args` against a scratch tree of its own, with the given patches. */
function build(name, patches, args = ["--apply-only"]) {
  const base = join(scratch, name);
  const patchDir = join(base, "patches");
  mkdirSync(patchDir, { recursive: true });
  for (const [file, body] of Object.entries(patches)) {
    writeFileSync(join(patchDir, file), body);
  }
  const vendor = join(base, "vendor", "kestrel");
  const r = rerun(vendor, patchDir, args);
  return {
    ...r,
    vendor,
    patchDir,
    record: join(base, "vendor", ".kestrel-build.json"),
    marker: join(base, "vendor", ".kestrel-authoring"),
  };
}

function rerun(vendor, patchDir, args, script = "scripts/fetch-kestrel.mjs") {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, KESTREL_VENDOR_DIR: vendor, KESTREL_PATCHES_DIR: patchDir },
  });
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
  const r = build("good", { "0001-good.patch": GOOD });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /applied .*0001-good\.patch/);
  assert.equal(readFileSync(join(r.vendor, "DEMO_PATCH_TEST"), "utf8"), "patched\n");
  assert.equal(existsSync(r.record), false, "--apply-only writes no build record");
});

test("a patch that doesn't apply stops the build, names it, and leaves nothing behind", () => {
  // A record from an earlier good build must not survive a failed one.
  const base = join(scratch, "bad", "vendor");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, ".kestrel-build.json"), '{"fingerprint":"from an earlier build"}\n');

  const r = build("bad", { "0001-good.patch": GOOD, "0002-bad.patch": BAD });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /0002-bad\.patch does not apply to Kestrel v\d+\.\d+\.\d+/);
  assert.equal(existsSync(r.vendor), false, "no half-patched tree is left");
  assert.equal(existsSync(r.record), false, "the earlier record is gone");
});

test("a build refuses to replace a tree left by --apply-only until --force", () => {
  const r = build("authoring", { "0001-good.patch": GOOD });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(r.marker), "--apply-only leaves the authoring marker");
  writeFileSync(join(r.vendor, "IN_PROGRESS"), "an edit in progress\n");

  // What `wrangler dev` runs: a plain build.
  const plain = rerun(r.vendor, r.patchDir, []);
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /a patch is being authored/);
  assert.equal(readFileSync(join(r.vendor, "IN_PROGRESS"), "utf8"), "an edit in progress\n");

  // --force ends the session (stopping at the patch step keeps the test fast).
  const forced = rerun(r.vendor, r.patchDir, ["--force", "--apply-only"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(
    existsSync(join(r.vendor, "IN_PROGRESS")),
    false,
    "--force starts from a fresh clone",
  );
});

test("the tree can't be the repo or contain it", () => {
  // A scratch copy of the script, so a broken guard could only delete scratch files.
  const repo = join(scratch, "guard-repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync("scripts/fetch-kestrel.mjs", join(repo, "scripts", "fetch-kestrel.mjs"));
  copyFileSync(".kestrel-version", join(repo, ".kestrel-version"));
  writeFileSync(join(repo, "keep"), "still here\n");

  for (const dir of [".", "..", repo]) {
    const r = rerun(dir, join(repo, "patches"), [], join(repo, "scripts", "fetch-kestrel.mjs"));
    assert.notEqual(r.status, 0, `KESTREL_VENDOR_DIR=${dir} must be refused`);
    assert.match(r.stderr, /refusing to use/);
    assert.equal(readFileSync(join(repo, "keep"), "utf8"), "still here\n");
  }
});
