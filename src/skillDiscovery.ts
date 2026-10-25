import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import YAML from "yaml";
import { PLATFORMS, type PlatformInfo } from "./platforms.js";
import { findSkillMdEntry } from "./skillMdFile.js";

export interface DiscoveredSkill {
  name: string;
  description: string;
  dir: string;
  platform: PlatformInfo;
  scope: "global" | "project";
  manifestFilename: string;
  /** False when init explicitly includes a malformed manifest for diagnosis. */
  manifestValid?: boolean;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function loadSkillsFrom(
  root: string,
  platform: PlatformInfo,
  scope: "global" | "project",
  includeMalformed = false,
): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [];
  if (!(await dirExists(root))) return skills;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = `${root}/${entry.name}`;
    try {
      const skillMdName = findSkillMdEntry(await readdir(dir, { withFileTypes: true }));
      if (!skillMdName) continue;
      const text = await readFile(`${dir}/${skillMdName}`, "utf8");
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let front: Record<string, unknown> | undefined;
      if (match) {
        try {
          const parsed = YAML.parse(match[1]) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
        } catch { /* Keep the folder visible to init. */ }
      }
      if (!front && !includeMalformed) continue;
      skills.push({
        name: String(front?.name ?? entry.name),
        description: String(front?.description ?? ""),
        dir,
        platform,
        scope,
        manifestFilename: skillMdName,
        manifestValid: Boolean(
          front && typeof front.name === "string" && front.name.trim() &&
          typeof front.description === "string" && front.description.trim(),
        ),
      });
    } catch {
      continue;
    }
  }
  return skills;
}

/** Discovers installed skills across every confirmed platform directory, global and project-local. */
export async function discoverAllSkills(cwd: string = process.cwd(), includeMalformed = false): Promise<DiscoveredSkill[]> {
  const home = homedir();
  const all: DiscoveredSkill[] = [];
  for (const platform of PLATFORMS) {
    if (platform.globalDir) {
      all.push(...(await loadSkillsFrom(platform.globalDir(home), platform, "global", includeMalformed)));
    }
    all.push(...(await loadSkillsFrom(platform.projectDir(cwd), platform, "project", includeMalformed)));
  }
  return all;
}
