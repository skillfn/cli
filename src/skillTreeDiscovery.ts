import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { findSkillMdEntry } from "./skillMdFile.js";
import { EXCLUDED_DIR_NAMES } from "./skillExclusions.js";

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

async function readFoundSkill(dir: string, skillMdName: string): Promise<FoundSkill | undefined> {
  try {
    const text = await readFile(join(dir, skillMdName), "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return undefined;
    const front = YAML.parse(match[1]) as Record<string, unknown>;
    return {
      name: String(front.name ?? dir.split("/").pop() ?? dir),
      description: String(front.description ?? ""),
      dir,
      manifestFilename: skillMdName,
    };
  } catch {
    return undefined; // malformed/unreadable SKILL.md
  }
}

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
      const found = await readFoundSkill(dir, skillMdName);
      if (found) skills.push(found);
      return; // a skill directory's own subdirectories (assets, scripts, etc.) aren't
      // separate skills -- stop descending once we've found this one's SKILL.md.
    }

    const subdirs = entries.filter((e) => e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name));
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

export interface VendoredSubtree {
  /** Absolute path of the boundary directory -- exclude this whole subtree from the
   * containing skill's own scan. */
  dir: string;
  reason: "git-repo" | "nested-skill";
}

/**
 * Finds vendored content nested *below* a directory that is already known to be a skill in
 * its own right (its own SKILL.md already found at `root` itself, by the caller) -- e.g. a
 * whole third-party repo, or just another skill package, copied inside this skill's folder.
 * `root` itself is never considered; only its subtree is searched.
 *
 * Two distinct boundary signals, checked top-down and never descended past once matched:
 *  - a directory containing its own `.git` -- the clearest possible "this is a separate,
 *    independently-versioned project" signal. The *whole* vendored repo is the boundary, not
 *    just its `.git` folder -- a vendored repo's own README/package.json/lockfile etc. living
 *    one level above any nested SKILL.md are just as much "not this skill's content" as the
 *    `.git` internals are (confirmed real case: a vendored supabase/agent-skills checkout's
 *    own README and package.json showed up as this skill's own npx-pinning and CVE findings).
 *  - a nested SKILL.md with no `.git` around it -- a skill package copied in directly, no
 *    version control, same "this is someone else's content" reasoning.
 * A git-repo boundary is still searched (without recursing past it) for any skill nested
 * inside it, purely so the caller can point the user at it to scan separately -- it doesn't
 * change the exclusion, which already covers the whole repo either way.
 *
 * Exists so a skill that happens to bundle another whole skill (or someone else's repo)
 * gets that content scanned and reported as its own thing, not silently folded into (and
 * misattributed to) the parent's own findings -- see resolveTargetsForPath in scan.ts and
 * skillSpectorScanner.ts's stageFilteredSkillDir.
 */
export async function findVendoredSubtreesUnder(root: string, maxDepth = 12): Promise<{ boundaries: VendoredSubtree[]; skills: FoundSkill[] }> {
  const boundaries: VendoredSubtree[] = [];
  const skills: FoundSkill[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      boundaries.push({ dir, reason: "git-repo" });
      const inner = await findSkillsUnder(dir, maxDepth - depth);
      skills.push(...inner.skills);
      return; // whole repo is the boundary -- don't recurse past it
    }

    const skillMdName = findSkillMdEntry(entries);
    if (skillMdName) {
      const found = await readFoundSkill(dir, skillMdName);
      if (found) {
        boundaries.push({ dir, reason: "nested-skill" });
        skills.push(found);
      }
      return;
    }

    const subdirs = entries.filter((e) => e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name));
    for (const entry of subdirs) {
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return { boundaries, skills };
  }
  const subdirs = rootEntries.filter((e) => e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name));
  await Promise.all(subdirs.map((entry) => walk(join(root, entry.name), 1)));
  return { boundaries, skills };
}
