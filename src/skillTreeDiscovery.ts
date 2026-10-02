import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { findSkillMdEntry } from "./skillMdFile.js";

export interface FoundSkill {
  name: string;
  description: string;
  dir: string;
  /** The real on-disk filename (e.g. "skill.md") -- compare against "SKILL.md" to flag a
   * non-canonical case, which other tools on a case-sensitive filesystem may not recognize
   * the way skillfn now generously does (see skillMdFile.ts). */
  manifestFilename: string;
}

/** A directory that looks like it was meant to be a skill package (has the subdirectory
 * structure the format conventionally uses) but has no manifest file under any name,
 * canonical or not. Heuristic, not certain -- surfaced for a human to verify, never
 * silently treated as a real skill. */
export interface OrphanedSkillFolder {
  dir: string;
  /** Which conventional skill-package subdirectory names were found, e.g. ["references", "scripts"]. */
  signals: string[];
}

export interface SkillTreeScan {
  skills: FoundSkill[];
  orphaned: OrphanedSkillFolder[];
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".svn", ".hg"]);

/**
 * Conventional subdirectory names a real skill package tends to have (references/
 * material, bundled scripts, worked examples, static assets, runtime adapters -- the
 * actual structure seen in real skills scanned this session, e.g. hyperframes-animation's
 * adapters/examples/references). Requiring at least two of these together (not just one)
 * keeps false positives down -- plenty of ordinary project folders have a lone "scripts/"
 * or "examples/" directory for entirely unrelated reasons.
 */
const SKILL_SHAPE_SIGNAL_DIRS = new Set(["references", "scripts", "examples", "assets", "adapters"]);
const MIN_SIGNALS_FOR_ORPHAN = 2;

/**
 * Finds every SKILL.md anywhere under `root`, however deeply nested -- unlike
 * skillDiscovery.ts (which only checks the one known directory level per platform), this
 * walks an arbitrary user-given path. Exists because pointing `skillfn scan` at a whole
 * project/skills-library root (rather than one skill's own directory) is a real, intended
 * use case, not a mistake to reject -- it just needs each skill scanned individually
 * instead of as one giant tree (see aggregateScan.ts for why).
 *
 * Also collects orphaned skill-shaped folders (see OrphanedSkillFolder) in the same pass,
 * rather than walking the tree twice for two related questions ("where are the skills"
 * and "where's a skill clearly missing its manifest").
 *
 * Does not follow symlinked directories, to avoid infinite loops on a cyclic link.
 */
export async function findSkillsUnder(root: string, maxDepth = 12): Promise<SkillTreeScan> {
  const skills: FoundSkill[] = [];
  const orphaned: OrphanedSkillFolder[] = [];

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
          skills.push({
            name: String(front.name ?? dir.split("/").pop() ?? dir),
            description: String(front.description ?? ""),
            dir,
            manifestFilename: skillMdName,
          });
        }
      } catch {
        // malformed/unreadable SKILL.md -- skip this one, keep walking
      }
      return; // a skill directory's own subdirectories (assets, scripts, etc.) aren't
      // separate skills -- stop descending once we've found this one's SKILL.md.
    }

    const subdirs = entries.filter((e) => e.isDirectory() && !SKIP_DIR_NAMES.has(e.name));
    const signals = subdirs.map((e) => e.name.toLowerCase()).filter((name) => SKILL_SHAPE_SIGNAL_DIRS.has(name));
    if (depth > 0 && signals.length >= MIN_SIGNALS_FOR_ORPHAN) {
      orphaned.push({ dir, signals });
    }

    for (const entry of subdirs) {
      // Dot-directories aren't skipped wholesale -- an archived/snapshotted skill living
      // under something like .archive/ is a real, intended find, not noise.
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return { skills, orphaned };
}
