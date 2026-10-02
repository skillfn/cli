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
      if (!match) continue;
      const front = YAML.parse(match[1]) as Record<string, unknown>;
      skills.push({
        name: String(front.name ?? entry.name),
        description: String(front.description ?? ""),
        dir,
        platform,
        scope,
        manifestFilename: skillMdName,
      });
    } catch {
      continue;
    }
  }
  return skills;
}

/** Discovers installed skills across every confirmed platform directory, global and project-local. */
export async function discoverAllSkills(cwd: string = process.cwd()): Promise<DiscoveredSkill[]> {
  const home = homedir();
  const all: DiscoveredSkill[] = [];
  for (const platform of PLATFORMS) {
    if (platform.globalDir) {
      all.push(...(await loadSkillsFrom(platform.globalDir(home), platform, "global")));
    }
    all.push(...(await loadSkillsFrom(platform.projectDir(cwd), platform, "project")));
  }
  return all;
}
