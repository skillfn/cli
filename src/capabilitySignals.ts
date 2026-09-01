import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * A lightweight, local, no-network heuristic for "does this skill likely need network
 * access or shell execution" — used to warn before mirroring a skill onto a platform
 * with a different capability posture (extra/plans/08-cross-platform-capabilities.md).
 * This is deliberately narrower than the full security scan (extra/plans/03-security-gate.md)
 * — it's a capability signal, not a safety verdict.
 */
export interface CapabilitySignals {
  likelyNetwork: boolean;
  likelyExec: boolean;
}

const NETWORK_INDICATORS = [
  /fetch\s*\(/i,
  /axios\.(post|get)\s*\(/i,
  /requests\.(post|get)\s*\(/i,
  /curl\s+https?:\/\//i,
  /wget\s+https?:\/\//i,
  /http\.request\s*\(/i,
];

const EXEC_INDICATORS = [
  /child_process\.exec/i,
  /subprocess\.(Popen|call|run)/i,
  /os\.system\s*\(/i,
  /\bexec\s*\(/i,
];

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

export async function sniffCapabilities(skillDir: string): Promise<CapabilitySignals> {
  const signals: CapabilitySignals = { likelyNetwork: false, likelyExec: false };

  for (const file of await walk(skillDir)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!signals.likelyNetwork && NETWORK_INDICATORS.some((re) => re.test(text))) {
      signals.likelyNetwork = true;
    }
    if (!signals.likelyExec && EXEC_INDICATORS.some((re) => re.test(text))) {
      signals.likelyExec = true;
    }
    if (signals.likelyNetwork && signals.likelyExec) break;
  }

  return signals;
}
