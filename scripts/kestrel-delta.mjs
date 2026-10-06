#!/usr/bin/env node
/*
 * What moving the demo to another Kestrel release involves (issue #11; the update-kestrel
 * skill drives it). Read-only: it changes nothing in this repo.
 *
 *   node scripts/kestrel-delta.mjs              # the pin → the latest release
 *   node scripts/kestrel-delta.mjs --to v1.3.0  # the pin → a given tag
 *   node scripts/kestrel-delta.mjs --from v1.1.0 --to v1.2.0   # any two tags (a rehearsal)
 *
 * With nothing newer than the pin, it says so and exits 0. Otherwise it prints a Markdown
 * report:
 *   - Kestrel's CHANGELOG entries between the two tags;
 *   - new or changed migrations (each sandbox applies them; DESIGN.md, "Updating the demo");
 *   - changes to what the wrapper imports or relies on (kestrel/entry.ts and the shim
 *     src/types/kestrel.d.ts must stay in step with these), and to Kestrel's wrangler config
 *     (compatibility date and flags, module rules);
 *   - changes to every file a patch in patches/ touches, and whether each patch still
 *     applies to the new tag (in order, as the build applies them);
 *   - D1 API the adapter may not cover (src/d1/adapter.ts): new uses of raw, exec, dump,
 *     withSession, or meta fields beyond `changes`.
 *
 * Env: KESTREL_REPO (default https://github.com/kurtbruns/kestrel.git), KESTREL_PATCHES_DIR
 * (default patches/, for a rehearsal with other patches).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.KESTREL_REPO || "https://github.com/kurtbruns/kestrel.git";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** What the wrapper imports from Kestrel, or builds from it (kestrel/entry.ts, the build). */
const WATCHED = [
  "src/index.ts",
  "src/env.ts",
  "src/dev/seed.ts",
  "src/dev/demo.ts",
  "src/lib/errors.ts",
  "src/generated/version.ts",
  "scripts/build-client.mjs",
  "scripts/stamp-version.mjs",
  "wrangler.jsonc",
  "package.json",
  "demo/",
];

const semver = (t) =>
  t
    .replace(/^v/, "")
    .split(/[.-]/)
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
function compareTags(a, b) {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) {
      continue;
    }
    if (x[i] === undefined) {
      return 1; // a release sorts after its pre-releases
    }
    if (y[i] === undefined) {
      return -1;
    }
    return typeof x[i] === "number" && typeof y[i] === "number"
      ? x[i] - y[i]
      : String(x[i]) < String(y[i])
        ? -1
        : 1;
  }
  return 0;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function releaseTags() {
  return git(["ls-remote", "--tags", "--refs", REPO])
    .split("\n")
    .map((l) => l.split("refs/tags/")[1])
    .filter((t) => t && /^v\d+\.\d+\.\d+$/.test(t))
    .sort(compareTags);
}

const pin = readFileSync(join(ROOT, ".kestrel-version"), "utf8").trim();
const from = flag("--from") ?? pin;
const to = flag("--to") ?? releaseTags().at(-1);

if (!to || compareTags(to, from) <= 0) {
  console.log(
    `Kestrel ${from} is the latest release${to && to !== from ? ` (newest tag ${to})` : ""}; nothing to update.`,
  );
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "kestrel-delta-"));
try {
  git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", REPO, dir]);
  git(["fetch", "--quiet", "--tags", "origin"], dir);
  const range = `${from}..${to}`;
  const changed = git(["diff", "--name-only", range], dir).split("\n").filter(Boolean);
  const out = [`# Kestrel ${from} → ${to}`, ""];

  // CHANGELOG: the sections for versions after `from`, up to and including `to`.
  const changelog = git(["show", `${to}:CHANGELOG.md`], dir);
  const sections = changelog.split(/^## /m).slice(1);
  const wanted = sections.filter((s) => {
    const v = /^\[(\d+\.\d+\.\d+)\]/.exec(s)?.[1];
    return v && compareTags(`v${v}`, from) > 0 && compareTags(`v${v}`, to) <= 0;
  });
  out.push(
    "## Changelog",
    "",
    wanted.length
      ? wanted.map((s) => `### ${s.trim()}`).join("\n\n")
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
      ? `${watched.map((f) => `- \`${f}\``).join("\n")}\n\nCheck \`kestrel/entry.ts\` and \`src/types/kestrel.d.ts\` against these.`
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

  // Patches: which of their files changed, and whether each still applies, in build order.
  const patchDir = resolve(ROOT, process.env.KESTREL_PATCHES_DIR || "patches");
  const patches = readdirSync(patchDir)
    .filter((f) => f.endsWith(".patch"))
    .sort();
  git(["-c", "advice.detachedHead=false", "checkout", "--quiet", to], dir);
  const rows = [];
  for (const p of patches) {
    const text = readFileSync(join(patchDir, p), "utf8");
    const files = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    const touched = files.filter((f) => changed.includes(f));
    let applies = "yes";
    try {
      git(["apply", "--check", join(patchDir, p)], dir);
      git(["apply", join(patchDir, p)], dir); // the next patch applies on top, as in the build
    } catch (err) {
      applies = `**no**: ${
        String(err.stderr ?? err)
          .trim()
          .split("\n")[0]
      }`;
    }
    rows.push(
      `| \`${p}\` | ${applies} | ${touched.length ? touched.map((f) => `\`${f}\``).join(", ") : "none"} |`,
    );
  }
  out.push(
    "## Patches",
    "",
    "| Patch | Applies to the new tag | Its files that changed |",
    "| --- | --- | --- |",
    ...rows,
    "",
  );

  // D1 API the adapter may not cover, counted in each tag's src/.
  const count = (ref, pattern) => {
    try {
      return git(["grep", "-c", "-E", pattern, ref, "--", "src/"], dir)
        .split("\n")
        .filter(Boolean)
        .filter((l) => !l.includes("src/send/budget.ts")) // the metering pass-through
        .reduce((n, l) => n + Number(l.split(":").at(-1)), 0);
    } catch {
      return 0; // git grep exits 1 on no match
    }
  };
  const apis = [
    ["`.raw(`", (ref) => count(ref, "\\.raw\\(")],
    ["`db.exec(` / `DB.exec(`", (ref) => count(ref, "(db|DB)\\.exec\\(")],
    ["`.dump(`", (ref) => count(ref, "\\.dump\\(")],
    ["`withSession`", (ref) => count(ref, "withSession")],
    // git grep -E has no lookahead: every meta field read, less the `changes` ones.
    [
      "`meta.` fields other than `changes`",
      (ref) => count(ref, "\\.meta\\.[a-z_]+") - count(ref, "\\.meta\\.changes"),
    ],
  ];
  const flagged = apis
    .map(([name, uses]) => [name, uses(from), uses(to)])
    .filter(([, a, b]) => b > a);
  out.push(
    "## D1 API the adapter may not cover",
    "",
    flagged.length
      ? flagged
          .map(([name, a, b]) => `- ${name}: ${a} → ${b} uses. Check \`src/d1/adapter.ts\`.`)
          .join("\n")
      : "_No new uses of D1 API beyond what the adapter implements._",
    "",
  );
  console.log(out.join("\n"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
