/** Shared workspace enumeration for repository scripts. */
import { readdirSync, existsSync } from "node:fs";

export const repoRoot = new URL("../", import.meta.url);

/** Directories that are TypeScript packages (have a tsconfig.json + package.json). */
export function workspaceDirs() {
  const out = [];
  for (const parent of ["runtime", "packages", "apps"]) {
    const parentUrl = new URL(`${parent}/`, repoRoot);
    if (!existsSync(parentUrl)) continue;
    for (const entry of readdirSync(parentUrl, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      if (existsSync(new URL(`${dir}/package.json`, repoRoot))) out.push(dir);
    }
  }
  return out.sort();
}

/** Every .ts source file in the workspace, as { dir, path, url }. */
export function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`${dir}/`, repoRoot), { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) out.push({ path: child, url: new URL(child, repoRoot) });
    }
  };
  for (const dir of [...workspaceDirs(), "tests"]) {
    if (existsSync(new URL(`${dir}/`, repoRoot))) walk(dir);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
