#!/usr/bin/env node
/** Removes every build output in the workspace. */
import { rm } from "node:fs/promises";
import { workspaceDirs, repoRoot } from "./_workspace.mjs";

for (const dir of [...workspaceDirs(), "tests"]) {
  await rm(new URL(`${dir}/dist`, repoRoot), { recursive: true, force: true });
}
console.log("clean: removed all dist/ output");
