// scripts/kestrel-delta.mjs, against the real Kestrel repo. Tied to the pin, not to fixed
// tags, so a version bump doesn't break it: nothing to do from the pin to itself, and a
// rehearsal from an older release to the pin that reports the changelog, shows every real
// patch applying, and flags a patch that doesn't (and leaves the rest unchecked).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const PIN = readFileSync(".kestrel-version", "utf8").trim();
/** An older release to rehearse from: the first 1.x, before every patch was written. */
const OLDER = "v1.1.0";

const scratch = mkdtempSync(join(tmpdir(), "kestrel-delta-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function delta(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/kestrel-delta.mjs", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("reports nothing to do from the pin to itself", () => {
  const r = delta(["--from", PIN, "--to", PIN]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to update/);
});

test("refuses a tag that doesn't exist, or a range backwards", () => {
  assert.equal(delta(["--to", "v99.0.0"]).status, 1);
  assert.equal(delta(["--from", PIN, "--to", OLDER]).status, 1);
});

test("a rehearsal to the pin reports the changelog and every patch, flagging one that won't apply", () => {
  const real = readdirSync("patches").filter((f) => f.endsWith(".patch"));
  for (const f of real) {
    copyFileSync(join("patches", f), join(scratch, f));
  }
  const broken =
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-No such line.\n+Nor this.\n";
  writeFileSync(join(scratch, "0098-broken.patch"), broken);
  writeFileSync(join(scratch, "0099-after.patch"), broken);
  const r = delta(["--from", OLDER, "--to", PIN], { KESTREL_PATCHES_DIR: scratch });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^# Kestrel ${OLDER} → ${PIN.replaceAll(".", "\\.")}`, "m"));
  assert.match(r.stdout, new RegExp(`^### \\[${PIN.slice(1).replaceAll(".", "\\.")}\\]`, "m"));
  // Only versions after --from.
  assert.doesNotMatch(
    r.stdout,
    new RegExp(`^### \\[${OLDER.slice(1).replaceAll(".", "\\.")}\\]`, "m"),
  );
  // The build applies every real patch at the pin, so the report must say so.
  for (const f of real) {
    assert.match(r.stdout, new RegExp(`\\| \`${f.replaceAll(".", "\\.")}\` \\| yes \\|`), f);
  }
  assert.match(r.stdout, /\| `0098-broken\.patch` \| \*\*no\*\*/);
  assert.match(r.stdout, /\| `0099-after\.patch` \| not checked: an earlier patch failed \|/);
});
