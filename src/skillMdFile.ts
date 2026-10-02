import type { Dirent } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";

export const CANONICAL_SKILL_MD = "SKILL.md";

/**
 * Finds a SKILL.md in an already-read directory listing, tolerant of case. Linux
 * filesystems (ext4, the common case on a fresh Ubuntu machine) are case-sensitive, unlike
 * the macOS/Windows defaults this was originally tested on -- a real on-disk `skill.md` or
 * `Skill.md` then silently fails an exact `=== "SKILL.md"` check and the skill is treated
 * as if it doesn't exist. Confirmed real case: `skillfn scan skills` reported "No SKILL.md
 * found" against a directory that plainly contained one, just lowercase.
 *
 * Prefers the exact canonical name when both happen to exist (shouldn't happen on a
 * case-sensitive filesystem, but stay deterministic if it does); returns the real on-disk
 * filename (preserving its actual case) so callers read the file that's actually there.
 */
export function findSkillMdEntry(entries: Dirent[]): string | undefined {
  const exact = entries.find((e) => e.isFile() && e.name === CANONICAL_SKILL_MD);
  if (exact) return exact.name;
  return entries.find((e) => e.isFile() && e.name.toLowerCase() === CANONICAL_SKILL_MD.toLowerCase())?.name;
}

/** Convenience wrapper for callers that haven't already read the directory themselves. */
export async function findSkillMdFilename(dir: string): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  return findSkillMdEntry(entries);
}

/**
 * Offers to rename a non-canonically-cased manifest to SKILL.md -- only when interactive
 * (never silently mutate a user's files without asking; never hang a non-interactive/
 * scripted run waiting for an answer nobody can give, so those are left exactly as found).
 * Safe by construction: findSkillMdEntry only ever returns a non-canonical name when no
 * exact "SKILL.md" already exists in that directory (it prefers the exact match first), so
 * this can never silently overwrite one. Returns the filename now in effect -- "SKILL.md"
 * if renamed, the original name otherwise (declined, non-interactive, or the rename itself
 * failed, e.g. permissions) -- so callers can update what they already know about the skill.
 */
export async function offerRenameToCanonical(dir: string, filename: string): Promise<string> {
  if (filename === CANONICAL_SKILL_MD || !process.stdin.isTTY) return filename;

  const confirmed = await p.confirm({
    message: `${join(dir, filename)} isn't named exactly "${CANONICAL_SKILL_MD}" (case matters on some filesystems/tools) -- rename it now?`,
    initialValue: true,
  });
  if (p.isCancel(confirmed) || !confirmed) return filename;

  try {
    await rename(join(dir, filename), join(dir, CANONICAL_SKILL_MD));
    p.log.success(`Renamed to ${join(dir, CANONICAL_SKILL_MD)}`);
    return CANONICAL_SKILL_MD;
  } catch (err) {
    p.log.warn(`Could not rename ${filename} -- ${err instanceof Error ? err.message : String(err)}`);
    return filename;
  }
}
