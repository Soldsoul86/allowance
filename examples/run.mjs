#!/usr/bin/env node
// Runs every example in order, each in its own process.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const examples = readdirSync(here).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();
let failed = 0;
for (const file of examples) {
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: "inherit" });
  if (result.status !== 0) failed += 1;
}
process.stdout.write(failed === 0 ? "\nall examples ran\n" : `\n${failed} example(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
