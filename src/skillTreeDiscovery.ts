import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { findSkillMdEntry } from "./skillMdFile.js";

export interface FoundSkill {
  name: string;
  description: string;
  dir: string;
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".svn", ".hg"]);

/**
 * Finds every SKILL.md anywhere under `root`, however deeply nested -- unlike
 * skillDiscovery.ts (which only checks the one known directory level per platform), this
 * walks an arbitrary user-given path. Exists because pointing `skillfn scan` at a whole
 * project/skills-library root (rather than one skill's own directory) is a real, intended
 * use case, not a mistake to reject -- it just needs each skill scanned individually
 * instead of as one giant tree (see aggregateScan.ts for why).
 *
 * Does not follow symlinked directories, to avoid infinite loops on a cyclic link.
 */
export async function findSkillsUnder(root: string, maxDepth = 12): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, race) -- skip, don't fail the whole walk
    }

    const skillMdName = findSkillMdEntry(entries);
    if (skillMdName) {
      const skillMdPath = join(dir, skillMdName);
      try {
        const text = await readFile(skillMdPath, "utf8");
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (match) {
          const front = YAML.parse(match[1]) as Record<string, unknown>;
          found.push({
            name: String(front.name ?? dir.split("/").pop() ?? dir),
            description: String(front.description ?? ""),
            dir,
          });
        }
      } catch {
        // malformed/unreadable SKILL.md -- skip this one, keep walking
      }
      return; // a skill directory's own subdirectories (assets, scripts, etc.) aren't
      // separate skills -- stop descending once we've found this one's SKILL.md.
    }

    for (const entry of entries) {
      // Dot-directories aren't skipped wholesale -- an archived/snapshotted skill living
      // under something like .archive/ is a real, intended find, not noise.
      if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}
