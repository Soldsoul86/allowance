#!/usr/bin/env node
/**
 * Publishes whatever is new, in dependency order.
 *
 *   node release.mjs            publish every package whose version is not on npm yet
 *   node release.mjs --dry-run  show what would be published and stop
 *
 * Packages are published journal first and dependents after, derived from
 * their own dependency fields rather than a hard-coded list. A package whose
 * exact version already exists on the registry is skipped, so re-running a
 * release after a partial failure finishes the job instead of failing on the
 * packages that already went out.
 *
 * Before anything is published, every internal dependency pin is checked
 * against the sibling's current version. The pins are exact on purpose, and
 * publishing a package that depends on a sibling version nobody has released
 * would break `npm install` for everyone who tried it.
 */
import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const root = new URL(".", import.meta.url).pathname;

const packages = readdirSync(join(root, "packages")).map((dir) => {
  const manifest = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  return { dir, name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {} };
});
const byName = new Map(packages.map((p) => [p.name, p]));

/* Internal pins must name the sibling version that is about to exist. */
const problems = [];
for (const p of packages) {
  for (const [dep, range] of Object.entries(p.dependencies)) {
    const sibling = byName.get(dep);
    if (sibling && range !== sibling.version) {
      problems.push(`${p.name} pins ${dep}@${range}, but the workspace has ${sibling.version}`);
    }
  }
}
if (problems.length > 0) {
  console.error("refusing to publish:\n  " + problems.join("\n  "));
  process.exit(1);
}

/* Dependency order: a package comes after every sibling it depends on. */
const ordered = [];
const visit = (p, trail = new Set()) => {
  if (ordered.includes(p)) return;
  if (trail.has(p)) throw new Error(`dependency cycle through ${p.name}`);
  trail.add(p);
  for (const dep of Object.keys(p.dependencies)) if (byName.has(dep)) visit(byName.get(dep), trail);
  ordered.push(p);
};
for (const p of packages) visit(p);

const run = (args, opts = {}) => spawnSync("npm", args, { stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", cwd: root });
const onRegistry = (p) => run(["view", `${p.name}@${p.version}`, "version"], { quiet: true }).status === 0;

const published = [];
const skipped = [];
for (const p of ordered) {
  if (onRegistry(p)) {
    skipped.push(`${p.name}@${p.version}`);
    console.log(`  =  ${p.name}@${p.version} is already on npm`);
    continue;
  }
  if (dryRun) {
    console.log(`  +  would publish ${p.name}@${p.version}`);
    published.push(`${p.name}@${p.version}`);
    continue;
  }
  console.log(`  +  publishing ${p.name}@${p.version}`);
  const result = run(["publish", "-w", p.name, ...(process.env.GITHUB_ACTIONS ? ["--provenance"] : [])]);
  if (result.status !== 0) {
    console.error(`publish failed for ${p.name}@${p.version}; packages already published this run: ${published.join(", ") || "none"}`);
    process.exit(result.status ?? 1);
  }
  published.push(`${p.name}@${p.version}`);
}

const summary = published.length === 0
  ? "Nothing new to publish; every package version is already on npm."
  : `Published: ${published.join(", ")}`;
console.log(`\n${summary}`);

/* Hand the list to the workflow step that writes the GitHub release. */
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `published=${published.join(" ")}\nskipped=${skipped.join(" ")}\n`);
}
