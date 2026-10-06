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
 * .kestrel-build.json, beside the tree, records what it was built from: a hash of the tag,
 * the clone source, the patches, and this script. When it matches, the build is skipped, so
 * wrangler's build.command keeps `wrangler dev` fast. It is removed before any work and
 * written only after everything succeeds, so a failed or interrupted build is never
 * mistaken for a good one.
 *
 * Flags:
 *   --force       rebuild even when the record matches, and end a patch-authoring session.
 *   --apply-only  clone and patch, then stop: no install, no client build, no record. For
 *                 authoring a patch (patches/README.md) and for the patch-mechanism test. It
 *                 leaves .kestrel-authoring beside the tree, and until a --force build clears
 *                 it every other build refuses to run, so `wrangler dev` (whose build.command
 *                 is this script) can't wipe edits in progress by recloning.
 *
 * Env (for tests and local experiments; CI and deploys use the defaults). Relative paths
 * resolve against the repo root, not the working directory:
 *   KESTREL_REPO         clone source, default https://github.com/kurtbruns/kestrel.git
 *   KESTREL_VENDOR_DIR   where the tree goes, default vendor/kestrel. Its parent holds the
 *                        record and the authoring marker, so give each tree its own parent.
 *   KESTREL_PATCHES_DIR  where the patches are, default patches/
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");
const REPO = process.env.KESTREL_REPO || "https://github.com/kurtbruns/kestrel.git";
const DIR = resolve(ROOT, process.env.KESTREL_VENDOR_DIR || "vendor/kestrel");
const PATCHES = resolve(ROOT, process.env.KESTREL_PATCHES_DIR || "patches");
const RECORD = join(dirname(DIR), ".kestrel-build.json");
const AUTHORING = join(dirname(DIR), ".kestrel-authoring");
const DEMO_ASSETS = join(dirname(DIR), "demo-assets.ts");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const applyOnly = args.has("--apply-only");

const say = (msg) => console.log(`[fetch-kestrel] ${msg}`);

function fail(msg) {
  console.error(`[fetch-kestrel] ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, cwd = ROOT) {
  try {
    execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  } catch {
    fail(`\`${cmd} ${cmdArgs.join(" ")}\` failed (see its output above)`);
  }
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
  const h = createHash("sha256").update(`${tag}\n${REPO}\n`).update(readFileSync(SCRIPT));
  for (const p of patches) {
    h.update(`${relative(PATCHES, p)}\n`).update(readFileSync(p));
  }
  return h.digest("hex");
}

function upToDate(print) {
  const built = ["dist/public/dashboard/index.html", "src/generated/version.ts"];
  if (
    !existsSync(RECORD) ||
    !existsSync(DEMO_ASSETS) ||
    !built.every((f) => existsSync(join(DIR, f)))
  ) {
    return false;
  }
  try {
    return JSON.parse(readFileSync(RECORD, "utf8")).fingerprint === print;
  } catch {
    return false;
  }
}

const IMAGE_TYPES = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/**
 * Write demo-assets.ts beside the tree: what the Worker bundles from Kestrel's repo besides
 * its code, as static imports. The images Kestrel's seed takes as files, which wrangler's
 * Data rule makes ArrayBuffers: every image beside a post's index.md, named
 * `<bundle>/<file>`, and the logo publication.md names. That is a superset of what Kestrel's
 * scripts/seed.mjs uploads (only the images a post shows), which is harmless: the seed looks
 * each image up by the name its post uses and ignores the rest. And its migrations/*.sql, as
 * text, in name order. Generated, so a release that adds a demo image or a migration needs
 * no change here.
 */
function writeDemoAssets() {
  const demo = join(DIR, "demo");
  const rel = (p) => `./${relative(dirname(DIR), p).split(sep).join("/")}`;
  const typeOf = (f) => IMAGE_TYPES[f.slice(f.lastIndexOf(".")).toLowerCase()];
  const imports = [];
  const images = [];
  const postsDir = join(demo, "posts");
  const bundles = readdirSync(postsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const bundle of bundles) {
    if (!bundle.isDirectory()) {
      continue;
    }
    for (const file of readdirSync(join(postsDir, bundle.name)).sort()) {
      if (typeOf(file)) {
        const name = `image${images.length}`;
        imports.push(
          `import ${name} from ${JSON.stringify(rel(join(postsDir, bundle.name, file)))};`,
        );
        images.push(
          `  { filename: ${JSON.stringify(`${bundle.name}/${file}`)}, contentType: ${JSON.stringify(typeOf(file))}, bytes: ${name} },`,
        );
      }
    }
  }
  const front = readFileSync(join(demo, "publication.md"), "utf8").match(/^---\n([\s\S]*?)\n---/);
  const logo = front?.[1].match(/^logo:\s*(.+?)\s*$/m)?.[1];
  let logoExport = "export const demoLogo = undefined;";
  const migrations = [];
  const migrationsDir = join(DIR, "migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const name = `migration${migrations.length}`;
    imports.push(`import ${name} from ${JSON.stringify(rel(join(migrationsDir, file)))};`);
    migrations.push(`  { name: ${JSON.stringify(file)}, sql: ${name} },`);
  }
  if (logo && typeOf(logo) && existsSync(join(demo, logo))) {
    imports.push(`import logo from ${JSON.stringify(rel(join(demo, logo)))};`);
    logoExport = `export const demoLogo = { contentType: ${JSON.stringify(typeOf(logo))}, bytes: logo };`;
  }
  writeFileSync(
    DEMO_ASSETS,
    [
      "// GENERATED by scripts/fetch-kestrel.mjs from Kestrel's demo/. Do not edit.",
      ...imports,
      "",
      `export const demoImages = [\n${images.join("\n")}\n];`,
      logoExport,
      `export const migrations = [\n${migrations.join("\n")}\n];`,
      "",
    ].join("\n"),
  );
}

// The tree is deleted wholesale below, so refuse a target that is the repo or contains it.
// Compared as real paths, since the same directory can be named through a symlink (macOS's
// /var is /private/var). DIR may not exist yet, so resolve its nearest existing ancestor.
function realPath(p) {
  let head = p;
  let tail = "";
  while (!existsSync(head) && head !== dirname(head)) {
    tail = tail ? join(basename(head), tail) : basename(head);
    head = dirname(head);
  }
  return join(realpathSync(head), tail);
}
const realDir = realPath(DIR);
const realRoot = realpathSync(ROOT);
if (realDir === realRoot || realRoot.startsWith(realDir + sep) || realDir === dirname(realDir)) {
  fail(`refusing to use ${DIR} as the Kestrel tree: it is or contains this repo`);
}

if (existsSync(AUTHORING) && !force && !applyOnly) {
  fail(
    `a patch is being authored in ${relative(ROOT, DIR)} (started with --apply-only), so this build won't replace it.\n` +
      "Finish the patch (patches/README.md), then run `node scripts/fetch-kestrel.mjs --force`.",
  );
}

const tag = tagFromPin();
const patches = patchFiles();
const print = fingerprint(tag, patches);

if (!force && !applyOnly && upToDate(print)) {
  say(`Kestrel ${tag} with ${patches.length} patch(es) is up to date in ${relative(ROOT, DIR)}`);
  process.exit(0);
}

rmSync(RECORD, { force: true });
rmSync(AUTHORING, { force: true });
rmSync(DEMO_ASSETS, { force: true });
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
        "Regenerate it against this tag (see patches/README.md), or drop it if the release made it unnecessary.",
    );
  }
  run("git", ["apply", p], DIR);
  say(`applied ${name}`);
}

if (applyOnly) {
  writeFileSync(AUTHORING, `${new Date().toISOString()}\n`);
  say(
    `stopped after patching (--apply-only): ${relative(ROOT, DIR)}. Other builds will refuse to run until \`--force\`.`,
  );
  process.exit(0);
}

say("installing Kestrel's dependencies (npm ci, which also writes its build stamp)");
run("npm", ["ci", "--no-audit", "--no-fund"], DIR);

say("building Kestrel's admin client");
run("node", ["scripts/build-client.mjs"], DIR);

say("indexing the demo's images for the seed");
writeDemoAssets();

writeFileSync(
  RECORD,
  `${JSON.stringify({ tag, repo: REPO, patches: patches.map((p) => relative(PATCHES, p)), fingerprint: print }, null, 2)}\n`,
);
say(`built Kestrel ${tag} with ${patches.length} patch(es)`);
