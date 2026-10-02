import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

/**
 * SkillSpector's own baseline/suppression mechanism (docs/SUPPRESSION.md in its repo,
 * addressing its issue #88) -- skillfn builds on this rather than reinventing a parallel
 * suppression system, since SkillSpector already fingerprints a finding with a SHA-256 over
 * canonical JSON (rule, file, matched text, context, scanner version, ...) and already wires
 * suppression into its own scoring/reporting. A second, independent suppression layer in
 * skillfn would either have to duplicate that exact hashing (a correctness risk neither tool
 * needs) or disagree with it.
 *
 * Trust model: skillfn always looks for this file inside the skill's OWN directory and uses
 * it automatically (see skillSpectorScanner.ts). That's a different, narrower case than
 * SkillSpector's own `--use-shipped-baseline` (off by default there, because a stranger's
 * skill shipping its own baseline could hide something from a reviewer) -- skillfn's normal
 * use is scanning a skill you yourself maintain, so a baseline file in that same directory is
 * your own prior review, the same trust level as a tracked .gitignore or eslintrc.
 */
export const BASELINE_FILENAME = ".skillspector-baseline.yaml";

export function baselinePathFor(skillDir: string): string {
  return join(skillDir, BASELINE_FILENAME);
}

export async function baselineExists(skillDir: string): Promise<boolean> {
  try {
    await readFile(baselinePathFor(skillDir));
    return true;
  } catch {
    return false;
  }
}

interface RawFingerprint {
  hash: string;
  rule_id: string;
  file: string;
  reason: string;
}

interface RawBaseline {
  version: number;
  scanner_version: string;
  rules: unknown[];
  fingerprints: RawFingerprint[];
}

/** A suppression candidate: one exact finding SkillSpector could fingerprint right now. */
export interface FingerprintCandidate {
  hash: string;
  ruleId: string;
  file: string;
}

class SuppressionError extends Error {}

/**
 * Runs `skillspector baseline` fresh against `skillDir` to get a correct, exact v2
 * fingerprint for every CURRENTLY active finding -- never hand-computed by skillfn, since
 * the hash binds the scanner version, normalized path, and complete decoded source text, and
 * only SkillSpector itself can produce one that it will later recognize. `--no-llm` keeps
 * this fast and key-free (consistent with every other skillfn scan). Always reflects the
 * directory's real current content: a previous baseline file already in `skillDir` has no
 * effect here, since `skillspector baseline` doesn't take one as input.
 */
export async function generateFreshFingerprints(skillDir: string): Promise<{ scannerVersion: string; fingerprints: FingerprintCandidate[] }> {
  const workDir = await mkdtemp(join(tmpdir(), "skillfn-baseline-"));
  const outputPath = join(workDir, "baseline.yaml");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("skillspector", ["baseline", skillDir, "--no-llm", "-o", outputPath], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new SuppressionError(`skillspector baseline exited ${code}`))));
    });
    const raw = YAML.parse(await readFile(outputPath, "utf8")) as RawBaseline;
    return {
      scannerVersion: raw.scanner_version,
      fingerprints: (raw.fingerprints ?? []).map((f) => ({ hash: f.hash, ruleId: f.rule_id, file: f.file })),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Merges newly-accepted fingerprints into `skillDir`'s baseline file, preserving every
 * existing entry (and its original reason) that's still among `currentFingerprints` --
 * dropping only entries for findings that no longer exist (the content changed enough that
 * the old exact fingerprint can't apply anyway). `scannerVersion` always comes from the same
 * fresh `generateFreshFingerprints` call as `currentFingerprints`, so the file's single
 * version field never ends up inconsistent with the hashes it's paired with. Preserves any
 * hand-authored `rules` entries already in the file untouched -- this only ever touches
 * `fingerprints`.
 */
export async function mergeFingerprintsIntoBaseline(
  skillDir: string,
  scannerVersion: string,
  currentFingerprints: FingerprintCandidate[],
  newlyAccepted: FingerprintCandidate[],
  reason: string,
): Promise<string> {
  const path = baselinePathFor(skillDir);
  let existing: RawBaseline | undefined;
  try {
    existing = YAML.parse(await readFile(path, "utf8")) as RawBaseline;
  } catch {
    existing = undefined;
  }

  const stillValidHashes = new Set(currentFingerprints.map((f) => f.hash));
  const previousByHash = new Map((existing?.fingerprints ?? []).filter((f) => stillValidHashes.has(f.hash)).map((f) => [f.hash, f]));

  const newlyAcceptedHashes = new Set(newlyAccepted.map((f) => f.hash));
  const fingerprints: RawFingerprint[] = currentFingerprints
    .filter((f) => previousByHash.has(f.hash) || newlyAcceptedHashes.has(f.hash))
    .map((f) => ({
      hash: f.hash,
      rule_id: f.ruleId,
      file: f.file,
      reason: newlyAcceptedHashes.has(f.hash) ? reason : (previousByHash.get(f.hash)?.reason ?? reason),
    }));

  const doc: RawBaseline = {
    version: 2,
    scanner_version: scannerVersion,
    rules: existing?.rules ?? [],
    fingerprints,
  };

  const header =
    "# SkillSpector baseline — findings listed here are suppressed on future scans.\n" +
    "# Written by skillfn ('skillfn scan' -> \"Mark a finding as reviewed\"). Commit this file.\n";
  await writeFile(path, header + YAML.stringify(doc), "utf8");
  return path;
}
