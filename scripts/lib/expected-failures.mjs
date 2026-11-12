/*
 * Compare a vitest JSON report of Kestrel's worker suite with the list of specs the patches
 * are expected to fail (scripts/kestrel-expected-failures.json). Pure, so the build tests can
 * drive it with made-up reports; scripts/kestrel-specs.mjs runs the suite and calls it.
 *
 * A spec is named by its file, relative to the Kestrel tree, and vitest's full name (the
 * describe titles and the test title joined by spaces). Comparison is by name, never by
 * count: one new failure and one fixed spec leave the count unchanged.
 */

import { relative, sep } from "node:path";

/** The key a spec is compared by. */
export const specKey = (file, name) => `${file} :: ${name}`;

/**
 * Read the list, checking its shape. Returns a Map from spec key to the patch that causes it.
 * `patchNames`, when given, is the set of patch basenames (without `.patch`) in patches/; a
 * group naming a patch that isn't there is an error, since a dropped patch takes its expected
 * failures with it.
 */
export function readExpected(list, patchNames) {
  const expected = new Map();
  const problems = [];
  if (!list || typeof list.patches !== "object") {
    throw new Error('the list has no "patches" object');
  }
  for (const [patch, group] of Object.entries(list.patches)) {
    if (patchNames && !patchNames.has(patch)) {
      problems.push(`group "${patch}" names no patch in patches/`);
    }
    if (typeof group.why !== "string" || !group.why.trim()) {
      problems.push(`group "${patch}" has no "why"`);
    }
    for (const [file, names] of Object.entries(group.specs ?? {})) {
      if (!Array.isArray(names)) {
        problems.push(`group "${patch}", ${file}: specs must be a list of names`);
        continue;
      }
      for (const name of names) {
        const key = specKey(file, name);
        if (expected.has(key)) {
          problems.push(`${key} is listed twice (under ${expected.get(key)} and ${patch})`);
        }
        expected.set(key, patch);
      }
    }
  }
  if (problems.length) {
    throw new Error(`the list is malformed:\n  ${problems.join("\n  ")}`);
  }
  return expected;
}

/**
 * Pull what failed, and every spec that ran, out of a vitest JSON report. `root` is the
 * Kestrel tree the report's absolute file paths are under. A file that failed without a
 * failed test in it (it didn't load, or a hook threw) is a failure of its own, named
 * `<file> :: (the file failed to run)`, since none of its specs can be checked.
 */
export function readReport(report, root) {
  const failed = new Map();
  const seen = new Set();
  for (const file of report.testResults ?? []) {
    const rel = relative(root, file.name).split(sep).join("/");
    let anyFailed = false;
    for (const t of file.assertionResults ?? []) {
      const key = specKey(rel, t.fullName);
      seen.add(key);
      if (t.status === "failed") {
        anyFailed = true;
        if (!failed.has(key)) {
          failed.set(key, firstLine(t.failureMessages?.[0]));
        }
      }
    }
    if (file.status === "failed" && !anyFailed) {
      failed.set(specKey(rel, "(the file failed to run)"), firstLine(file.message));
    }
  }
  return { failed, seen };
}

const firstLine = (s) => (s ?? "").split("\n")[0].slice(0, 200);

/**
 * The difference, both ways: `unexpected` failed and isn't listed; `stale` is listed and
 * didn't fail, split into `passing` (it ran and passed) and `missing` (no spec by that name
 * ran: renamed, moved, or deleted upstream).
 */
export function compare(expected, { failed, seen }) {
  const unexpected = [...failed.keys()]
    .filter((k) => !expected.has(k))
    .sort()
    .map((key) => ({ key, message: failed.get(key) }));
  const stale = [...expected.keys()].filter((k) => !failed.has(k)).sort();
  return {
    unexpected,
    passing: stale.filter((k) => seen.has(k)).map((key) => ({ key, patch: expected.get(key) })),
    missing: stale.filter((k) => !seen.has(k)).map((key) => ({ key, patch: expected.get(key) })),
  };
}
