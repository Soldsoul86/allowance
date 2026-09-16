#!/usr/bin/env node
/**
 * The Groth16 setup, split out from compilation so it can be resumed.
 *
 * The ceremony for a 110k-constraint circuit takes minutes, and re-running the
 * compile to get to it wastes them. Each step is skipped when its output
 * already exists, so an interrupted run picks up where it stopped.
 *
 * DEVELOPMENT ONLY. The randomness is generated here and not destroyed, so
 * anyone with this machine's history could forge proofs. Production needs a
 * multi-party ceremony, or a proving system with no trusted setup at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const a = (name) => join(root, "artifacts", name);
const snarkjs = (...args) => {
  process.stdout.write(`  $ snarkjs ${args.slice(0, 3).join(" ")}\n`);
  execFileSync("npx", ["--no-install", "snarkjs", ...args], {
    cwd: join(root, "..", ".."),
    stdio: ["ignore", "inherit", "inherit"],
  });
};
const step = (output, fn) => {
  if (existsSync(a(output))) {
    process.stdout.write(`  = ${output} already built\n`);
    return;
  }
  fn();
};

// 110,028 constraints needs 2^17 = 131,072.
step("pot_0.ptau", () => snarkjs("powersoftau", "new", "bn128", "17", a("pot_0.ptau"), "-v"));
step("pot_1.ptau", () =>
  snarkjs("powersoftau", "contribute", a("pot_0.ptau"), a("pot_1.ptau"),
    "--name=dev", "-v", "-e=orb-development-entropy-not-for-production"));
step("pot_final.ptau", () =>
  snarkjs("powersoftau", "prepare", "phase2", a("pot_1.ptau"), a("pot_final.ptau"), "-v"));
step("budget_0.zkey", () =>
  snarkjs("groth16", "setup", a("budget.r1cs"), a("pot_final.ptau"), a("budget_0.zkey")));
step("budget.zkey", () =>
  snarkjs("zkey", "contribute", a("budget_0.zkey"), a("budget.zkey"),
    "--name=dev", "-v", "-e=orb-development-entropy-not-for-production"));
step("verification_key.json", () =>
  snarkjs("zkey", "export", "verificationkey", a("budget.zkey"), a("verification_key.json")));

for (const f of ["pot_0.ptau", "pot_1.ptau", "pot_final.ptau", "budget_0.zkey"]) {
  rmSync(a(f), { force: true });
}
process.stdout.write("\nsetup complete\n");
