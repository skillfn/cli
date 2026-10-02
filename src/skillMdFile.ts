import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";

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
  const exact = entries.find((e) => e.isFile() && e.name === "SKILL.md");
  if (exact) return exact.name;
  return entries.find((e) => e.isFile() && e.name.toLowerCase() === "skill.md")?.name;
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
