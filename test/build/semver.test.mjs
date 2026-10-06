// scripts/lib/semver.mjs: SemVer precedence on release tags.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTags, isVersionTag } from "../../scripts/lib/semver.mjs";

test("orders releases and pre-releases by SemVer precedence", () => {
  const ordered = [
    "v1.0.0-alpha",
    "v1.0.0-alpha.1",
    "v1.0.0-alpha.beta",
    "v1.0.0-beta",
    "v1.0.0-beta.2",
    "v1.0.0-beta.11",
    "v1.0.0-rc.1",
    "v1.0.0",
    "v1.2.0",
    "v1.10.0",
    "v2.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compareTags(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.ok(compareTags(ordered[i + 1], ordered[i]) > 0, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareTags("v1.2.0", "v1.2.0"), 0);
});

test("knows a version tag", () => {
  assert.ok(isVersionTag("v1.2.0"));
  assert.ok(isVersionTag("v1.3.0-rc.1"));
  assert.ok(!isVersionTag("1.2.0"));
  assert.ok(!isVersionTag("latest"));
});
