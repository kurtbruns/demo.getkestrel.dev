#!/usr/bin/env node
/*
 * Build Kestrel at the pinned release, plus this repo's patch set (DESIGN.md, "Version pin"
 * and "The patch set").
 *
 *   1. Shallow-clone Kestrel at the tag in .kestrel-version into the gitignored vendor/kestrel.
 *   2. Apply patches/*.patch in filename order with `git apply`. One that doesn't apply stops
 *      the build, naming the patch: a Kestrel release that changed the patched lines fails
 *      here, in the PR that bumped the pin, never quietly later.
 *   3. Run Kestrel's own `npm ci` (its postinstall writes the build stamp,
 *      src/generated/version.ts) and its client build (dist/public, served as our assets).
 *
 * A clone rather than a git dependency: npm installs a git dependency without its
 * devDependencies (the client build needs esbuild) and without .git (the stamp would read
 * "dev" instead of the tag), and the patches need a working tree to apply to.
 *
 * vendor/.kestrel-build.json records what the tree was built from (the tag and a hash of
 * the patches). When it matches, the build is skipped, so wrangler's build.command keeps
 * `wrangler dev` fast. It is removed before any work and written only after everything
 * succeeds, so a failed or interrupted build is never mistaken for a good one.
 *
 * Flags:
 *   --force       rebuild even when the record matches.
 *   --apply-only  clone and patch, then stop: no install, no client build, no record. For
 *                 authoring a patch (edit vendor/kestrel, `git diff` there) and for the
 *                 patch-mechanism test.
 *
 * Env (for tests and local experiments; CI and deploys use the defaults):
 *   KESTREL_REPO         clone source, default https://github.com/kurtbruns/kestrel.git
 *   KESTREL_VENDOR_DIR   where the tree goes, default vendor/kestrel
 *   KESTREL_PATCHES_DIR  where the patches are, default patches/
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.KESTREL_REPO || "https://github.com/kurtbruns/kestrel.git";
const DIR = resolve(ROOT, process.env.KESTREL_VENDOR_DIR || "vendor/kestrel");
const PATCHES = resolve(ROOT, process.env.KESTREL_PATCHES_DIR || "patches");
const RECORD = join(dirname(DIR), ".kestrel-build.json");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const applyOnly = args.has("--apply-only");

const say = (msg) => console.log(`[fetch-kestrel] ${msg}`);

function fail(msg) {
  console.error(`[fetch-kestrel] ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, cwd = ROOT) {
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
}

function tagFromPin() {
  const tag = readFileSync(join(ROOT, ".kestrel-version"), "utf8").trim();
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    fail(`.kestrel-version must hold a release tag like v1.2.0, not "${tag}"`);
  }
  return tag;
}

function patchFiles() {
  if (!existsSync(PATCHES)) {
    return [];
  }
  return readdirSync(PATCHES)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => join(PATCHES, f));
}

function fingerprint(tag, patches) {
  const h = createHash("sha256").update(`${tag}\n`);
  for (const p of patches) {
    h.update(`${relative(PATCHES, p)}\n`).update(readFileSync(p));
  }
  return h.digest("hex");
}

function upToDate(print) {
  if (!existsSync(RECORD) || !existsSync(join(DIR, "dist/public/dashboard/index.html"))) {
    return false;
  }
  try {
    return JSON.parse(readFileSync(RECORD, "utf8")).fingerprint === print;
  } catch {
    return false;
  }
}

const tag = tagFromPin();
const patches = patchFiles();
const print = fingerprint(tag, patches);

if (!force && !applyOnly && upToDate(print)) {
  say(`Kestrel ${tag} with ${patches.length} patch(es) is up to date in ${relative(ROOT, DIR)}`);
  process.exit(0);
}

rmSync(RECORD, { force: true });
rmSync(DIR, { recursive: true, force: true });
mkdirSync(dirname(DIR), { recursive: true });

say(`cloning ${REPO} at ${tag}`);
run("git", [
  "-c",
  "advice.detachedHead=false",
  "clone",
  "--quiet",
  "--depth",
  "1",
  "--branch",
  tag,
  REPO,
  DIR,
]);

for (const p of patches) {
  const name = relative(ROOT, p);
  try {
    execFileSync("git", ["apply", "--check", p], { cwd: DIR, stdio: "pipe" });
  } catch (err) {
    const detail = err.stderr?.toString().trim() ?? "";
    // Leave no tree behind that looks like a build, patched or not.
    rmSync(DIR, { recursive: true, force: true });
    fail(
      `${name} does not apply to Kestrel ${tag}.\n${detail}\n` +
        'Regenerate it against this tag (see .claude/CLAUDE.md, "Patches"), or drop it if the release made it unnecessary.',
    );
  }
  run("git", ["apply", p], DIR);
  say(`applied ${name}`);
}

if (applyOnly) {
  say(`stopped after patching (--apply-only): ${relative(ROOT, DIR)}`);
  process.exit(0);
}

say("installing Kestrel's dependencies (npm ci, which also writes its build stamp)");
run("npm", ["ci", "--no-audit", "--no-fund"], DIR);

say("building Kestrel's admin client");
run("node", ["scripts/build-client.mjs"], DIR);

writeFileSync(
  RECORD,
  `${JSON.stringify({ tag, patches: patches.map((p) => relative(PATCHES, p)), fingerprint: print }, null, 2)}\n`,
);
say(`built Kestrel ${tag} with ${patches.length} patch(es)`);
