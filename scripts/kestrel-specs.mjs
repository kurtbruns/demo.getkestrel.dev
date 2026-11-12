#!/usr/bin/env node
/*
 * Run Kestrel's worker spec suite on the patched tree and check that what fails is exactly
 * what the patches are expected to make fail (DESIGN.md, "The patch set").
 *
 * The patches change Kestrel's behavior on purpose, so the specs that assert the unpatched
 * behavior fail on the patched tree. scripts/kestrel-expected-failures.json lists them by file
 * and full test name, grouped under the patch that causes them, each group with a "why". This
 * script runs the suite with vitest's JSON reporter and compares by name, both ways:
 *
 *   - a spec that fails and isn't listed: a real regression, or a new spec a patch fails on
 *     purpose, to be read and then listed under its patch;
 *   - a listed spec that passes: a patch may have stopped taking effect, or Kestrel changed
 *     the spec;
 *   - a listed spec that no longer exists: renamed, moved, or deleted upstream.
 *
 * Any of these exits 1, printing each set by name. Exactly the listed set failing exits 0.
 *
 * It first runs scripts/fetch-kestrel.mjs, which reuses vendor/kestrel when its record
 * matches the pin and the patches, so the suite always runs on the tree they describe.
 *
 * Flags:
 *   --report <file>  compare an existing vitest JSON report instead of running the suite
 *                    (paths in it must be under vendor/kestrel)
 *   --save <file>    keep the report the run wrote
 *   --list <file>    the expected-failures list, default scripts/kestrel-expected-failures.json
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, readExpected, readReport } from "./lib/expected-failures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KESTREL = join(ROOT, "vendor/kestrel");

const say = (msg) => console.log(`[kestrel-specs] ${msg}`);
function fail(msg) {
  console.error(`[kestrel-specs] ${msg}`);
  process.exit(2);
}

function flag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    fail(`${name} needs a file`);
  }
  return resolve(value);
}

const listPath = flag("--list") ?? join(ROOT, "scripts/kestrel-expected-failures.json");
const reportArg = flag("--report");
const savePath = flag("--save");

const patchNames = new Set(
  readdirSync(join(ROOT, "patches"))
    .filter((f) => f.endsWith(".patch"))
    .map((f) => f.replace(/\.patch$/, "")),
);
let expected;
try {
  expected = readExpected(JSON.parse(readFileSync(listPath, "utf8")), patchNames);
} catch (err) {
  fail(`${listPath}: ${err.message}`);
}

let reportPath = reportArg;
let scratch;
if (!reportPath) {
  const build = spawnSync(process.execPath, [join(ROOT, "scripts/fetch-kestrel.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    fail("the build failed, so the suite can't run on the patched tree");
  }
  scratch = mkdtempSync(join(tmpdir(), "kestrel-specs-"));
  reportPath = join(scratch, "worker.json");
  say("running Kestrel's worker specs on the patched tree");
  const started = Date.now();
  const run = spawnSync(
    "npx",
    ["vitest", "run", "--project", "worker", "--reporter=json", `--outputFile=${reportPath}`],
    { cwd: KESTREL, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  say(`the suite took ${Math.round((Date.now() - started) / 1000)}s`);
  try {
    readFileSync(reportPath);
  } catch {
    // No report means vitest itself failed (config, workerd), not a spec: show why.
    process.stderr.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    fail(`vitest wrote no report (exit ${run.status})`);
  }
  if (savePath) {
    copyFileSync(reportPath, savePath);
  }
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (scratch) {
  rmSync(scratch, { recursive: true, force: true });
}
const ran = readReport(report, KESTREL);
const { unexpected, passing, missing } = compare(expected, ran);

const perPatch = {};
for (const patch of expected.values()) {
  perPatch[patch] = (perPatch[patch] ?? 0) + 1;
}
say(
  `${report.numTotalTests ?? ran.seen.size} specs ran, ${ran.failed.size} failed; ${expected.size} expected to fail (${Object.entries(
    perPatch,
  )
    .map(([p, n]) => `${n} under ${p}`)
    .join(", ")})`,
);

if (!unexpected.length && !passing.length && !missing.length) {
  say("OK: the failures are exactly the expected ones");
  process.exit(0);
}

if (unexpected.length) {
  console.log(
    `\nUnexpected failures (${unexpected.length}): these fail and aren't listed. Each is a real regression until read; one a patch causes on purpose goes in the list under that patch.`,
  );
  for (const { key, message } of unexpected) {
    console.log(`  ${key}\n      ${message}`);
  }
}
if (passing.length) {
  console.log(
    `\nListed but passing (${passing.length}): a patch may have stopped taking effect, so check that it still does what it says before removing these. Or Kestrel changed the spec so it no longer sees the patch.`,
  );
  for (const { key, patch } of passing) {
    console.log(`  [${patch}] ${key}`);
  }
}
if (missing.length) {
  console.log(
    `\nListed but not found (${missing.length}): no spec by this name ran, so Kestrel renamed, moved or deleted it. Find what replaced it among the unexpected failures, if anything.`,
  );
  for (const { key, patch } of missing) {
    console.log(`  [${patch}] ${key}`);
  }
}
console.log(
  `\nThe list is ${listPath.replace(`${ROOT}/`, "")}; DESIGN.md ("The patch set") says how to add or remove an entry.`,
);
process.exit(1);
