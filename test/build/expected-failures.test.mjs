// scripts/lib/expected-failures.mjs, the comparison behind scripts/kestrel-specs.mjs, against
// made-up reports; and the real list, which must read cleanly against the real patches/.
// Running Kestrel's suite itself is `npm run test:kestrel`, not part of this.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  compare,
  readExpected,
  readReport,
  specKey,
} from "../../scripts/lib/expected-failures.mjs";

const ROOT = "/k";
const list = (specs) => ({ patches: { "0001-demo-auth": { why: "auth", specs } } });
const report = (files) => ({
  testResults: Object.entries(files).map(([file, tests]) => ({
    name: `${ROOT}/${file}`,
    status: Object.values(tests).includes("failed") ? "failed" : "passed",
    assertionResults: Object.entries(tests).map(([fullName, status]) => ({
      fullName,
      status,
      failureMessages: status === "failed" ? [`AssertionError: ${fullName}\n  at …`] : [],
    })),
  })),
});

test("the real list reads cleanly against patches/", () => {
  const patches = new Set(
    readdirSync("patches")
      .filter((f) => f.endsWith(".patch"))
      .map((f) => f.replace(/\.patch$/, "")),
  );
  const expected = readExpected(
    JSON.parse(readFileSync("scripts/kestrel-expected-failures.json", "utf8")),
    patches,
  );
  assert.ok(expected.size > 0);
});

test("exactly the listed failures is no difference", () => {
  const expected = readExpected(list({ "test/a.spec.ts": ["a 401s"] }));
  const ran = readReport(
    report({ "test/a.spec.ts": { "a 401s": "failed", other: "passed" } }),
    ROOT,
  );
  assert.deepEqual(compare(expected, ran), { unexpected: [], passing: [], missing: [] });
});

test("compares by name, so a swap with the same count is caught both ways", () => {
  const expected = readExpected(list({ "test/a.spec.ts": ["old"] }));
  const ran = readReport(report({ "test/a.spec.ts": { old: "passed", new: "failed" } }), ROOT);
  const diff = compare(expected, ran);
  assert.deepEqual(
    diff.unexpected.map((u) => u.key),
    [specKey("test/a.spec.ts", "new")],
  );
  assert.match(diff.unexpected[0].message, /^AssertionError: new$/);
  assert.deepEqual(diff.passing, [
    { key: specKey("test/a.spec.ts", "old"), patch: "0001-demo-auth" },
  ]);
  assert.deepEqual(diff.missing, []);
});

test("a listed spec that didn't run is missing, not passing", () => {
  const expected = readExpected(list({ "test/a.spec.ts": ["gone"] }));
  const diff = compare(
    expected,
    readReport(report({ "test/a.spec.ts": { kept: "passed" } }), ROOT),
  );
  assert.deepEqual(diff.passing, []);
  assert.deepEqual(diff.missing, [
    { key: specKey("test/a.spec.ts", "gone"), patch: "0001-demo-auth" },
  ]);
});

test("a file that failed to run is a failure of its own", () => {
  const ran = readReport(
    {
      testResults: [
        {
          name: `${ROOT}/test/b.spec.ts`,
          status: "failed",
          message: "SyntaxError",
          assertionResults: [],
        },
      ],
    },
    ROOT,
  );
  const diff = compare(readExpected(list({})), ran);
  assert.deepEqual(diff.unexpected, [
    { key: specKey("test/b.spec.ts", "(the file failed to run)"), message: "SyntaxError" },
  ]);
});

test("refuses a malformed list: no why, a group for no patch, a spec listed twice", () => {
  assert.throws(
    () => readExpected({ patches: { "0001-demo-auth": { specs: {} } } }),
    /has no "why"/,
  );
  assert.throws(
    () => readExpected(list({}), new Set(["0002-fake-outbox-bound"])),
    /names no patch in patches/,
  );
  assert.throws(
    () =>
      readExpected({
        patches: {
          "0001-demo-auth": { why: "a", specs: { "t.ts": ["x"] } },
          "0004-demo-chrome": { why: "b", specs: { "t.ts": ["x"] } },
        },
      }),
    /listed twice/,
  );
});
