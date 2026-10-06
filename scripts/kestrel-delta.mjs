#!/usr/bin/env node
/*
 * What moving the demo to another Kestrel release involves (issue #11; the update-kestrel
 * skill drives it). Read-only: it changes nothing in this repo.
 *
 *   node scripts/kestrel-delta.mjs              # the pin → the latest release
 *   node scripts/kestrel-delta.mjs --to v1.3.0  # the pin → a given tag
 *   node scripts/kestrel-delta.mjs --from v1.1.0 --to v1.2.0   # any two tags (a rehearsal)
 *
 * With nothing newer than the pin, it says so and exits 0. A tag that doesn't exist, or a
 * `--from` after `--to`, is an error (exit 1). Otherwise it prints a Markdown report:
 *   - Kestrel's CHANGELOG entries after `--from`, up to and including `--to`;
 *   - new or changed migrations (each sandbox applies them; DESIGN.md, "Updating the demo");
 *   - changes to what the wrapper imports or relies on (kestrel/entry.ts and the shim
 *     src/types/kestrel.d.ts must stay in step with these), and to Kestrel's wrangler config
 *     (compatibility date and flags, module rules);
 *   - for each patch in patches/, whether it applies to the new tag on top of the ones
 *     before it (as the build applies them; after one fails, the rest aren't checked), and
 *     which of its files changed;
 *   - new lines using D1 API the adapter doesn't implement (src/d1/adapter.ts): withSession,
 *     dump, or a `meta` field other than `changes`.
 *
 * Env: KESTREL_REPO (default https://github.com/kurtbruns/kestrel.git), KESTREL_PATCHES_DIR
 * (default patches/, for a rehearsal with other patches).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareTags, isVersionTag } from "./lib/semver.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.KESTREL_REPO || "https://github.com/kurtbruns/kestrel.git";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** What the wrapper imports from Kestrel (kestrel/entry.ts), or builds from it. */
const WATCHED = [
  "src/index.ts",
  "src/env.ts",
  "src/dev/seed.ts",
  "src/dev/demo.ts",
  "src/lib/errors.ts",
  "src/providers/fake.ts",
  "src/notify/fake.ts",
  "src/build.ts",
  "scripts/build-client.mjs",
  "scripts/seed.mjs",
  "scripts/stamp-version.mjs",
  "wrangler.jsonc",
  "package.json",
  "demo/",
];

function fail(msg) {
  console.error(`[kestrel-delta] ${msg}`);
  process.exit(1);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const tags = git(["ls-remote", "--tags", "--refs", REPO])
  .split("\n")
  .map((l) => l.split("refs/tags/")[1])
  .filter((t) => t && isVersionTag(t));
const releases = tags.filter((t) => !t.includes("-")).sort(compareTags);

const pin = readFileSync(join(ROOT, ".kestrel-version"), "utf8").trim();
const from = flag("--from") ?? pin;
const to = flag("--to") ?? releases.at(-1) ?? from;
for (const t of [from, to]) {
  if (!tags.includes(t)) {
    fail(
      `${t} is not a Kestrel version tag (tags look like v1.2.0; ${REPO} has ${releases.join(", ")})`,
    );
  }
}
const order = compareTags(to, from);
if (order < 0) {
  fail(`--from ${from} is after --to ${to}`);
}
if (order === 0) {
  console.log(`Kestrel ${from} is the latest release; nothing to update.`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "kestrel-delta-"));
try {
  git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", REPO, dir]);
  git(["fetch", "--quiet", "--tags", "origin"], dir);
  const range = `${from}..${to}`;
  const changed = git(["diff", "--name-only", range], dir).split("\n").filter(Boolean);
  const out = [`# Kestrel ${from} → ${to}`, ""];

  // CHANGELOG: the sections for versions after `from`, up to and including `to`, with their
  // own headings demoted under this report's.
  const changelog = git(["show", `${to}:CHANGELOG.md`], dir);
  const sections = changelog.split(/^## /m).slice(1);
  const wanted = sections.filter((s) => {
    const v = /^\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/.exec(s)?.[1];
    return v && compareTags(`v${v}`, from) > 0 && compareTags(`v${v}`, to) <= 0;
  });
  out.push(
    "## Changelog",
    "",
    wanted.length
      ? wanted.map((s) => `### ${s.trim().replace(/^### /gm, "#### ")}`).join("\n\n")
      : "_No changelog entries between these tags._",
    "",
  );

  const migrations = changed.filter((f) => f.startsWith("migrations/"));
  out.push(
    "## Migrations",
    "",
    migrations.length ? migrations.map((f) => `- \`${f}\``).join("\n") : "_None._",
    "",
  );

  const watched = changed.filter((f) =>
    WATCHED.some((w) => (w.endsWith("/") ? f.startsWith(w) : f === w)),
  );
  out.push(
    "## What the wrapper imports or relies on",
    "",
    watched.length
      ? `${watched.map((f) => `- \`${f}\``).join("\n")}\n\nCheck \`kestrel/entry.ts\`, \`src/types/kestrel.d.ts\` and \`src/sandbox.ts\` against these.`
      : "_Unchanged._",
    "",
  );
  if (changed.includes("wrangler.jsonc")) {
    const pick = (ref) =>
      git(["show", `${ref}:wrangler.jsonc`], dir)
        .split("\n")
        .filter((l) => /compatibility_(date|flags)|"rules"|"type":/.test(l))
        .map((l) => l.trim())
        .join("\n");
    out.push(
      "Kestrel's `wrangler.jsonc` compatibility and rules, before and after:",
      "",
      "```",
      pick(from),
      "---",
      pick(to),
      "```",
      "",
    );
  }

  // Patches, in build order, each on top of the ones before it. After one fails, the build
  // stops, so the rest aren't checked.
  const patchDir = resolve(ROOT, process.env.KESTREL_PATCHES_DIR || "patches");
  const patches = existsSync(patchDir)
    ? readdirSync(patchDir)
        .filter((f) => f.endsWith(".patch"))
        .sort()
    : [];
  git(["-c", "advice.detachedHead=false", "checkout", "--quiet", to], dir);
  const rows = [];
  let failed = false;
  for (const p of patches) {
    const text = readFileSync(join(patchDir, p), "utf8");
    const files = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    const touched = files.filter((f) => changed.includes(f));
    let applies = "yes";
    if (failed) {
      applies = "not checked: an earlier patch failed";
    } else {
      try {
        git(["apply", "--check", join(patchDir, p)], dir);
        git(["apply", join(patchDir, p)], dir);
      } catch (err) {
        failed = true;
        applies = `**no**: ${
          String(err.stderr ?? err)
            .trim()
            .split("\n")[0]
        }`;
      }
    }
    rows.push(
      `| \`${p}\` | ${applies} | ${touched.length ? touched.map((f) => `\`${f}\``).join(", ") : "none"} |`,
    );
  }
  out.push(
    "## Patches",
    "",
    patches.length
      ? [
          "| Patch | Applies to the new tag | Its files that changed |",
          "| --- | --- | --- |",
          ...rows,
        ].join("\n")
      : "_No patches._",
    "",
  );

  // D1 API the adapter doesn't implement: lines in `to`'s src/ that `from` doesn't have.
  // (prepare/bind/first/all/run/raw/batch/exec and meta.changes are implemented.)
  const uses = (ref) => {
    try {
      return new Set(
        git(
          [
            "grep",
            "-h",
            "-E",
            "withSession|\\.dump\\(|meta\\??\\.[a-z_]+|\\{[^}]*\\bmeta\\b",
            ref,
            "--",
            "src/",
          ],
          dir,
        )
          .split("\n")
          .map((l) => l.trim())
          // withSession, dump, a meta field other than changes, or meta destructured.
          .filter((l) =>
            /withSession|\.dump\(|meta\??\.(?!changes\b)[a-z_]+|\{[^}]*\bmeta\b[^}]*\}\s*=/.test(l),
          ),
      );
    } catch {
      return new Set(); // git grep exits 1 on no match
    }
  };
  const before = uses(from);
  const added = [...uses(to)].filter((l) => !before.has(l));
  out.push(
    "## D1 API the adapter may not cover",
    "",
    added.length
      ? `New lines using D1 API beyond what \`src/d1/adapter.ts\` implements:\n\n${added.map((l) => `- \`${l.replaceAll("`", "'")}\``).join("\n")}`
      : "_No new uses of D1 API beyond what the adapter implements._",
    "",
  );
  console.log(out.join("\n"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
