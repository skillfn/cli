import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PLATFORMS } from "./platforms.js";
import { discoverAllSkills, type DiscoveredSkill } from "./skillDiscovery.js";

export interface CodingSession {
  provider: "claude-code" | "codex";
  project: string;
  file: string;
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

async function jsonlFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/** Read only the beginning of a transcript. No messages or session contents go in the index. */
async function sessionProject(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const record = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
        const cwd = record.payload?.cwd ?? record.cwd;
        if (typeof cwd === "string" && isAbsolute(cwd)) return cwd;
      } catch { /* Ignore a partial or unrelated line. */ }
    }
  } finally {
    await handle.close();
  }
  return undefined;
}

/** Optional status callback so a caller can drive a spinner; discovery itself stays UI-free. */
export type DiscoveryProgress = (message: string) => void;

export async function discoverCodingSessions(home = homedir(), onProgress?: DiscoveryProgress): Promise<CodingSession[]> {
  const candidates: Array<{ provider: CodingSession["provider"]; file: string }> = [];
  for (const projectDir of await directories(join(home, ".claude", "projects"))) {
    for (const file of await jsonlFiles(projectDir)) candidates.push({ provider: "claude-code", file });
  }
  for (const year of await directories(join(home, ".codex", "sessions"))) {
    for (const month of await directories(year)) {
      for (const day of await directories(month)) {
        for (const file of await jsonlFiles(day)) candidates.push({ provider: "codex", file });
      }
    }
  }
  const sessions: CodingSession[] = [];
  for (const [index, candidate] of candidates.entries()) {
    onProgress?.(`Reading coding sessions (${index + 1}/${candidates.length})`);
    try {
      const project = await sessionProject(candidate.file);
      if (project && (await stat(project)).isDirectory()) sessions.push({ ...candidate, project: await realpath(project) });
    } catch { /* Stale or unreadable session/project. */ }
  }
  return sessions;
}

export async function discoverInitInventory(cwd = process.cwd(), home = homedir(), onProgress?: DiscoveryProgress): Promise<{
  sessions: CodingSession[];
  projects: string[];
  skills: DiscoveredSkill[];
  activeProviders: string[];
}> {
  const sessions = await discoverCodingSessions(home, onProgress);
  const projects = [...new Set([resolve(cwd), ...sessions.map((session) => session.project)])];
  const skills: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const [index, project] of projects.entries()) {
    onProgress?.(`Looking for skills in project ${index + 1}/${projects.length}`);
    for (const skill of await discoverAllSkills(project, true)) {
      const key = `${skill.platform.id}:${skill.scope}:${skill.dir}`;
      if (!seen.has(key)) { seen.add(key); skills.push(skill); }
    }
  }
  onProgress?.("Detecting active providers");
  const activeProviders: string[] = [];
  const markers: Record<string, string[]> = {
    "claude-code": [join(home, ".claude")],
    codex: [join(home, ".codex")],
    cursor: [join(home, ".cursor")],
    openclaw: [join(home, ".openclaw")],
    hermes: [join(home, ".hermes")],
    antigravity: [join(home, ".gemini")],
    copilot: [join(home, ".copilot")],
    opencode: [join(home, ".config", "opencode")],
    "kimi-code": [join(home, ".kimi")],
    "kilo-code": [join(home, ".kilo")],
  };
  for (const platform of PLATFORMS) {
    const globalRoot = platform.globalDir?.(home);
    const hasGlobal = globalRoot ? await stat(globalRoot).then(() => true, () => false) : false;
    const hasMarker = await Promise.all((markers[platform.id] ?? []).map((path) => stat(path).then(() => true, () => false)));
    const hasProject = await Promise.all(projects.map((project) => {
      const root = platform.projectDir(project);
      // .agents/skills belongs to both Codex and Antigravity. Treat it as a
      // project marker only for Codex; Antigravity needs its own home marker.
      if (platform.id === "antigravity") return Promise.resolve(false);
      const marker = platform.id === "windsurf" ? dirname(root) : root;
      return stat(marker).then(() => true, () => false);
    }));
    if (hasGlobal || hasMarker.some(Boolean) || hasProject.some(Boolean) || sessions.some((session) => session.provider === platform.id)) activeProviders.push(platform.id);
  }
  return { sessions, projects, skills, activeProviders };
}
