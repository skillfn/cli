import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Reads the CLI's own version from package.json at runtime instead of a hardcoded
 * literal -- avoids the drift bug where index.ts's `.version()` call and package.json's
 * `version` field silently fell out of sync with each other.
 *
 * This file compiles to dist/selfVersion.js; package.json sits one level up from dist/
 * both in the repo and in the published npm package (npm always includes package.json
 * regardless of the "files" allowlist), so the relative path holds in both contexts.
 */
export async function getInstalledVersion(): Promise<string> {
  const pkgPath = join(__dirname, "..", "package.json");
  const raw = await readFile(pkgPath, "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/** Returns undefined (rather than throwing) on any network/registry problem. */
export async function getLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch("https://registry.npmjs.org/skillfn/latest");
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch {
    return undefined;
  }
}

function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True if `latest` is a newer version than `current` (simple major.minor.patch compare). */
export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}
