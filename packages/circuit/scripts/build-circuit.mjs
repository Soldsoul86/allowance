#!/usr/bin/env node
/**
 * Compiles the circuit and runs a Groth16 setup.
 *
 *   node scripts/build-circuit.mjs
 *
 * Produces artifacts/ — the r1cs, the witness calculator, the proving key and
 * the verification key. They are build outputs, not source.
 *
 * ## About the setup
 *
 * Groth16 needs a structured reference string, and whoever generates it can
 * forge proofs if they keep the randomness ("toxic waste"). The ceremony here
 * is generated locally and unattended, which means **these artifacts are for
 * development only**. A real deployment either runs a multi-party ceremony, or
 * uses a proving system with no trusted setup (PLONK with a universal SRS,
 * or a STARK). This is stated in the README rather than buried here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const artifacts = join(root, "artifacts");
const circuits = join(root, "circuits");
const circomlib = join(root, "..", "..", "node_modules", "circomlib", "circuits");

const run = (cmd, args, cwd = root) => {
  process.stdout.write(`  $ ${cmd} ${args.slice(0, 4).join(" ")}...\n`);
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
};
const snarkjs = (...args) => run("npx", ["--no-install", "snarkjs", ...args]);

rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });

process.stdout.write("\ncompiling\n");
run("circom", [
  join(circuits, "budget.circom"),
  "--r1cs", "--wasm", "--sym",
  "-l", circomlib,
  "-o", artifacts,
]);

process.stdout.write("\nconstraints\n");
const info = execFileSync("npx", ["--no-install", "snarkjs", "r1cs", "info", join(artifacts, "budget.r1cs")], {
  cwd: root, encoding: "utf8",
});
process.stdout.write(info.split("\n").filter((l) => l.includes("Constraints") || l.includes("Wires") || l.includes("Public")).map((l) => `  ${l.trim()}`).join("\n") + "\n");

// 2^17 comfortably covers the circuit; a bigger ceremony only wastes time.
process.stdout.write("\nceremony (development only — see the header)\n");
snarkjs("powersoftau", "new", "bn128", "17", join(artifacts, "pot_0.ptau"), "-v");
snarkjs("powersoftau", "contribute", join(artifacts, "pot_0.ptau"), join(artifacts, "pot_1.ptau"),
  "--name=dev", "-v", "-e=orb-development-entropy-not-for-production");
snarkjs("powersoftau", "prepare", "phase2", join(artifacts, "pot_1.ptau"), join(artifacts, "pot_final.ptau"), "-v");

process.stdout.write("\ngroth16 setup\n");
snarkjs("groth16", "setup", join(artifacts, "budget.r1cs"), join(artifacts, "pot_final.ptau"), join(artifacts, "budget_0.zkey"));
snarkjs("zkey", "contribute", join(artifacts, "budget_0.zkey"), join(artifacts, "budget.zkey"),
  "--name=dev", "-v", "-e=orb-development-entropy-not-for-production");
snarkjs("zkey", "export", "verificationkey", join(artifacts, "budget.zkey"), join(artifacts, "verification_key.json"));

// The intermediates are large and reproducible; only the final keys are kept.
for (const f of ["pot_0.ptau", "pot_1.ptau", "pot_final.ptau", "budget_0.zkey"]) {
  rmSync(join(artifacts, f), { force: true });
}

process.stdout.write("\ndone — artifacts/budget.zkey, verification_key.json, budget_js/\n");
