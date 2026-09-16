#!/usr/bin/env node
/**
 * CLAUDE.md: "Every module must compile independently."
 * Builds each package on its own, in a clean build-info state, and fails if any
 * package cannot be typechecked without the others being built first.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workspaceDirs, repoRoot } from "./_workspace.mjs";

let failed = 0;
for (const dir of workspaceDirs()) {
  process.stdout.write(`typecheck ${dir} ... `);
  try {
    execFileSync(process.execPath, [
      fileURLToPath(new URL("node_modules/typescript/lib/tsc.js", repoRoot)),
      "-b", fileURLToPath(new URL(dir, repoRoot)),
    ], { stdio: "pipe" });
    console.log("ok");
  } catch (error) {
    failed++;
    console.log("FAILED");
    process.stdout.write(String(error.stdout ?? "") + String(error.stderr ?? ""));
  }
}
if (failed > 0) {
  console.error(`\ntypecheck: ${failed} package(s) failed to compile independently`);
  process.exit(1);
}
console.log("\ntypecheck: all packages compile independently");
