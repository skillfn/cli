import { watch as fsWatch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { PLATFORMS } from "../platforms.js";
import { discoverAllSkills, type DiscoveredSkill } from "../skillDiscovery.js";
import { loadConfig, muteSkill, isSkillMuted } from "../config.js";

/**
 * Explicit, opt-in, foreground watcher — never a silently-installed background daemon
 * (extra/plans/09-growth-funnel-and-business-model.md explains why that distinction
 * matters for trust). Run it yourself, or wire it into your own cron/systemd unit if
 * you want it always-on; skillfn will never install one for you.
 *
 * Detects newly-appeared local skills and, governed by `skillfn config`'s
 * publish-prompts setting, nudges toward publishing — never blocking or degrading any
 * local functionality regardless of the answer.
 */

function skillKey(s: DiscoveredSkill): string {
  return `${s.platform.id}:${s.scope}:${s.name}`;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function promptYesNoNever(question: string): Promise<"yes" | "no" | "never"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N/never] `)).trim().toLowerCase();
    if (answer === "never") return "never";
    if (answer === "y" || answer === "yes") return "yes";
    return "no";
  } finally {
    rl.close();
  }
}

async function handleNewSkill(skill: DiscoveredSkill): Promise<void> {
  const config = await loadConfig();

  if (config.publishPrompts === "never") return;
  if (await isSkillMuted(skill.name)) return;

  console.log(
    `\nNew skill detected: "${skill.name}" (${skill.platform.label}, ${skill.scope}) — ${skill.dir}`,
  );

  if (config.publishPrompts === "always") {
    console.log(
      "  publish-prompts=always, but hub publishing isn't wired up yet (needs Supabase — " +
        "extra/plans/07-roadmap.md, Phase 2). Run 'skillfn publish' once it lands.",
    );
    return;
  }

  const answer = await promptYesNoNever(
    "  Publish it to the hub? (signing, lineage credit, ranking visibility, reach to other users)",
  );
  if (answer === "never") {
    await muteSkill(skill.name);
    console.log(`  Won't ask about "${skill.name}" again (skillfn config unmute "${skill.name}" to undo).`);
  } else if (answer === "yes") {
    console.log("  Hub publishing isn't wired up yet — run 'skillfn publish' once it lands.");
  }
}

export async function watchCommand(): Promise<void> {
  console.log("skillfn watch — foreground, local-only, no telemetry. Ctrl+C to stop.\n");

  let known = new Set((await discoverAllSkills()).map(skillKey));
  const watchers: FSWatcher[] = [];
  let debounceTimer: NodeJS.Timeout | undefined;

  const rescan = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const current = await discoverAllSkills();
      for (const skill of current) {
        const key = skillKey(skill);
        if (!known.has(key)) {
          known.add(key);
          await handleNewSkill(skill);
        }
      }
    }, 300);
  };

  const home = homedir();
  const cwd = process.cwd();
  const roots = new Set<string>();
  for (const platform of PLATFORMS) {
    if (platform.globalDir) roots.add(platform.globalDir(home));
    roots.add(platform.projectDir(cwd));
  }

  let watchedCount = 0;
  for (const root of roots) {
    if (!(await dirExists(root))) continue; // a skill can't appear in a tree that doesn't exist yet
    try {
      watchers.push(fsWatch(root, { recursive: false }, rescan));
      watchedCount++;
    } catch {
      continue; // some filesystems/platforms don't support watching a given path — skip it
    }
  }

  console.log(`Watching ${watchedCount} existing skill director${watchedCount === 1 ? "y" : "ies"}.`);
  if (watchedCount === 0) {
    console.log("No known platform skill directories exist yet on this machine — nothing to watch.");
  }

  process.on("SIGINT", () => {
    for (const w of watchers) w.close();
    process.exit(0);
  });

  await new Promise(() => {}); // run until Ctrl+C
}
