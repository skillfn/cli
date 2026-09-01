import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

interface LocalSkill {
  name: string;
  description: string;
  dir: string;
  scope: "global" | "project";
}

interface UsageResult {
  usedInProjects: Set<string>; // encoded project-log directory names, not decoded paths
  hitCount: number;
}

const GLOBAL_SKILLS_DIR = join(homedir(), ".claude", "skills");
const PROJECT_SKILLS_DIR = join(process.cwd(), ".claude", "skills");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function loadLocalSkills(
  root: string,
  scope: "global" | "project",
): Promise<LocalSkill[]> {
  const skills: LocalSkill[] = [];
  if (!(await dirExists(root))) return skills;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillMdPath = join(dir, "SKILL.md");
    try {
      const text = await readFile(skillMdPath, "utf8");
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) continue;
      const front = YAML.parse(match[1]) as Record<string, unknown>;
      skills.push({
        name: String(front.name ?? entry.name),
        description: String(front.description ?? ""),
        dir,
        scope,
      });
    } catch {
      continue;
    }
  }
  return skills;
}

/**
 * Find every Claude Code session transcript (.jsonl) on this machine, across every
 * project the user has ever worked in — not just the current one. This is required to
 * answer "was this skill ever used" honestly for globally-installed (~/.claude/skills)
 * skills, since they can be triggered from any project. We only ever read local files
 * the current OS user already owns; nothing leaves this machine.
 */
async function findAllTranscripts(): Promise<Array<{ file: string; projectKey: string }>> {
  const results: Array<{ file: string; projectKey: string }> = [];
  if (!(await dirExists(CLAUDE_PROJECTS_DIR))) return results;

  for (const entry of await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(CLAUDE_PROJECTS_DIR, entry.name);
    for (const item of await readdir(projectDir, { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith(".jsonl")) {
        results.push({ file: join(projectDir, item.name), projectKey: entry.name });
      }
    }
  }
  return results;
}

/**
 * A skill counts as "used" if its exact tool name was invoked via the Skill tool, or its
 * absolute directory path shows up in a Read/Bash/Grep tool call — NOT on a bare text
 * mention of "SKILL.md", which would false-positive on any conversation that discusses
 * the format itself (as this project's own history proves).
 */
async function scanTranscriptForSkills(
  file: string,
  skills: LocalSkill[],
  usage: Map<string, UsageResult>,
  projectKey: string,
): Promise<void> {
  const skillToolMarkers = skills.map((s) => `"skill":"${s.name}"`);
  const pathMarkers = skills.map((s) => s.dir);

  const rl = createInterface({ input: createReadStream(file, "utf8") });
  for await (const line of rl) {
    if (!line.includes('"name":"Skill"') && !line.includes(".claude/skills")) continue;

    for (let i = 0; i < skills.length; i++) {
      if (line.includes(skillToolMarkers[i]) || line.includes(pathMarkers[i])) {
        const key = skills[i].name;
        const existing = usage.get(key) ?? { usedInProjects: new Set(), hitCount: 0 };
        existing.usedInProjects.add(projectKey);
        existing.hitCount += 1;
        usage.set(key, existing);
      }
    }
  }
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wordsB = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

const DUPLICATE_THRESHOLD = 0.6;

export async function auditCommand(): Promise<void> {
  const globalSkills = await loadLocalSkills(GLOBAL_SKILLS_DIR, "global");
  const projectSkills = await loadLocalSkills(PROJECT_SKILLS_DIR, "project");
  const all = [...globalSkills, ...projectSkills];

  if (all.length === 0) {
    console.log(
      "No installed skills found in .claude/skills (project) or ~/.claude/skills (personal).",
    );
    return;
  }

  const transcripts = await findAllTranscripts();
  const usage = new Map<string, UsageResult>();
  for (const { file, projectKey } of transcripts) {
    try {
      await scanTranscriptForSkills(file, all, usage, projectKey);
    } catch {
      continue; // unreadable/corrupt log — skip it, don't fail the whole audit
    }
  }

  const neverUsed = all.filter((s) => !usage.has(s.name));

  console.log(
    `You have ${all.length} skill(s) installed (${globalSkills.length} global, ${projectSkills.length} project-local).`,
  );
  console.log(
    `${neverUsed.length} have never been triggered, across ${transcripts.length} session log(s) scanned on this machine.\n`,
  );

  console.log("Global (~/.claude/skills):");
  if (globalSkills.length === 0) console.log("  (none)");
  for (const s of globalSkills) {
    const u = usage.get(s.name);
    if (!u) {
      console.log(`  - ${s.name}: never used`);
    } else {
      console.log(
        `  - ${s.name}: used in ${u.usedInProjects.size} project(s), ${u.hitCount} reference(s)`,
      );
    }
  }

  console.log("\nProject-local (.claude/skills, this project):");
  if (projectSkills.length === 0) console.log("  (none)");
  for (const s of projectSkills) {
    const u = usage.get(s.name);
    console.log(`  - ${s.name}: ${u ? `used, ${u.hitCount} reference(s)` : "never used"}`);
  }

  const pairs: Array<{ a: LocalSkill; b: LocalSkill; score: number }> = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const score = jaccardSimilarity(all[i].description, all[j].description);
      if (score >= DUPLICATE_THRESHOLD) {
        pairs.push({ a: all[i], b: all[j], score });
      }
    }
  }

  if (pairs.length > 0) {
    console.log("\nPossible duplicates (description-overlap heuristic, no AI key used):");
    for (const p of pairs) {
      console.log(
        `  - "${p.a.name}" and "${p.b.name}"  (similarity ${(p.score * 100).toFixed(0)}%)`,
      );
    }
  } else {
    console.log("\nNo likely duplicates found by the local heuristic.");
  }

  console.log(
    "\nNote: usage detection relies on this machine's local Claude Code session logs " +
      "(~/.claude/projects/**/*.jsonl) and only counts what's recorded there — skills used " +
      "on another machine, or before logs were written, won't show up. Detection matches an " +
      "exact Skill-tool invocation or the skill's exact directory path, not a bare text mention.",
  );
}
