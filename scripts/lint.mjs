#!/usr/bin/env node
/**
 * The repository linter.
 *
 * Rather than depend on a third-party rule engine, this enforces the specific
 * invariants `PRINCIPLES.md` imposes on this repository — a pure functional
 * core, no `any`, no escape hatches, no secrets, every package documented.
 * It is deliberately small, deterministic, and dependency-free.
 */
import { readFileSync, existsSync } from "node:fs";
import { workspaceDirs, sourceFiles, repoRoot } from "./_workspace.mjs";

const problems = [];
const report = (path, line, rule, message) =>
  problems.push({ path, line, rule, message });

/* ------------------------------------------------------------------ *
 * Structural rules
 * ------------------------------------------------------------------ */

// CLAUDE.md: "Every package must have README.md, DESIGN.md, API.md, TESTS.md".
for (const dir of workspaceDirs()) {
  for (const doc of ["README.md", "DESIGN.md", "API.md", "TESTS.md"]) {
    if (!existsSync(new URL(`${dir}/${doc}`, repoRoot))) {
      report(`${dir}/${doc}`, 0, "package-docs", `missing required package document ${doc}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Source rules
 * ------------------------------------------------------------------ */

/**
 * Files permitted to read process.env.
 *
 * Empty, and that is the point: these packages take their configuration as
 * arguments. A library that reads the environment decides things its caller
 * cannot see, which is the last property you want in one that decides whether
 * money may move.
 */
const ENV_ALLOWLIST = [];

/** Files permitted to use non-deterministic sources directly. */
const NONDETERMINISM_ALLOWLIST = [
  "packages/journal/src/ids.ts", // event ids
];

/**
 * Domain cores that must stay pure: no I/O, no clock, no randomness.
 *
 * `evaluate()` and everything it reaches is the reason this rule exists. A
 * decision that consults a clock cannot be replayed, and a decision that
 * cannot be replayed cannot be audited.
 */
const FUNCTIONAL_CORE = [
  "packages/policy/src/evaluate.ts",
  "packages/policy/src/policy.ts",
  "packages/policy/src/ledger.ts",
  "packages/policy/src/model.ts",
  "packages/policy/src/units.ts",
  "packages/policy/src/wire.ts",
  "packages/policy/src/quote.ts",
  "packages/policy/src/commitment.ts",
  "packages/policy/src/buckets.ts",
];

const RULES = [
  {
    id: "no-any",
    // `any` defeats TypeScript strict mode. `unknown` is always available.
    test: (line) => /(:|<|\bas\s+)\s*any\b/.test(line) && !line.includes("lint-allow: no-any"),
    message: "`any` is forbidden — use `unknown` and narrow, or declare the real type",
  },
  {
    id: "no-ts-escape-hatch",
    test: (line) => /@ts-(ignore|nocheck|expect-error)/.test(line),
    message: "TypeScript escape hatches are forbidden — fix the type instead",
  },
  {
    id: "no-test-only",
    test: (line) => /\b(it|test|describe)\.only\b/.test(line),
    message: "`.only` would silently skip the rest of the suite",
  },
  {
    id: "no-hardcoded-secret",
    test: (line) =>
      /(0x)?[0-9a-fA-F]{64}["'`]\s*(;|,|\)|$)/.test(line) &&
      /(privateKey|PRIVATE_KEY|secret|SECRET|mnemonic|seed)/i.test(line),
    message: "a private key or secret must never appear in source",
  },
  {
    id: "centralised-config",
    test: (line, file) =>
      /process\.env\b/.test(line) && !ENV_ALLOWLIST.includes(file),
    message: "read configuration through apps/executor/src/config.ts, never process.env directly",
  },
  {
    id: "no-vendor-sdk",
    test: (line) =>
      /from\s+["'](@nktkas\/hyperliquid|hyperliquid|ccxt|ethers|viem)["']/.test(line),
    message: "no exchange/wallet vendor SDK — Constitution Art. VIII §31 (no vendor lock-in)",
  },
  {
    id: "pure-core",
    test: (line, file) =>
      FUNCTIONAL_CORE.some((prefix) => file.startsWith(prefix)) &&
      /\b(Date\.now|Math\.random|new Date\(\)|fetch\(|require\(|node:fs|node:http)\b/.test(line),
    message: "the functional core must be pure — inject clocks, randomness and I/O",
  },
  {
    id: "no-nondeterminism-outside-shell",
    test: (line, file) =>
      /\bMath\.random\b/.test(line) && !NONDETERMINISM_ALLOWLIST.includes(file),
    message: "Math.random is not acceptable for identifiers or nonces — use node:crypto",
  },
];

for (const file of sourceFiles()) {
  const text = readFileSync(file.url, "utf8");
  const lines = text.split("\n");

  if (!/^\/\*\*/.test(text) && !/^\/\/ /.test(text)) {
    report(file.path, 1, "file-header", "every source file starts with a doc comment stating its purpose");
  }

  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "").replace(/\s+\*\s.*$/, "");
    for (const rule of RULES) {
      if (rule.test(code, file.path)) report(file.path, index + 1, rule.id, rule.message);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

if (problems.length === 0) {
  console.log(`lint: ${sourceFiles().length} files, no problems`);
  process.exit(0);
}
for (const p of problems) {
  console.error(`${p.path}:${p.line}  [${p.rule}]  ${p.message}`);
}
console.error(`\nlint: ${problems.length} problem(s)`);
process.exit(1);
