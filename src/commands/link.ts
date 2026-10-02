import { mkdir, lstat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { discoverAllSkills, type DiscoveredSkill } from "../skillDiscovery.js";
import { PLATFORMS, findPlatform, type PlatformInfo } from "../platforms.js";
import { sniffCapabilities } from "../capabilitySignals.js";
import { skillListLabel, truncateHint } from "../ui.js";

interface LinkOptions {
  to?: string;
}

/**
 * `skillfn link` with no args -- most people won't remember `skillfn link my-skill --to
 * openclaw` on their own, and shouldn't need to. Interactive picking (arrow keys, `@clack/
 * prompts`) is the default; `<skillName>`/`--to` stay fully supported for scripts and AI
 * agents, which are comfortable with explicit flags.
 */
async function pickSourceInteractively(all: DiscoveredSkill[]): Promise<DiscoveredSkill | undefined> {
  if (all.length === 0) {
    p.log.error(`No installed skills found across confirmed platforms (${PLATFORMS.map((pl) => pl.label).join(", ")}).`);
    return undefined;
  }

  const seen = new Set<string>();
  const unique = all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));

  const choice = await p.select({
    message: "Which skill do you want to link to another platform?",
    options: unique.map((s) => ({
      value: s.name,
      label: skillListLabel(s.name, s.platform.label),
      hint: s.description ? truncateHint(s.description) : undefined,
    })),
  });
  if (p.isCancel(choice)) return undefined;
  return all.find((s) => s.name === choice);
}

async function pickTargetsInteractively(sourcePlatformId: string): Promise<PlatformInfo[] | undefined> {
  const candidates = PLATFORMS.filter((pl) => pl.id !== sourcePlatformId);
  const choice = await p.multiselect({
    message: "Link it to which platform(s)? (space to select, enter to confirm)",
    options: candidates.map((pl) => ({ value: pl.id, label: pl.label })),
    required: true,
  });
  if (p.isCancel(choice)) return undefined;
  const chosenIds = choice as string[];
  return candidates.filter((pl) => chosenIds.includes(pl.id));
}

export async function linkCommand(skillName: string | undefined, options: LinkOptions = {}): Promise<void> {
  const all = await discoverAllSkills();
  const interactive = !skillName || !options.to;

  let source: DiscoveredSkill | undefined;
  if (skillName) {
    const matches = all.filter((s) => s.name === skillName);
    if (matches.length === 0) {
      console.log(
        `No installed skill named "${skillName}" found across confirmed platforms (${PLATFORMS.map((pl) => pl.label).join(", ")}).`,
      );
      process.exitCode = 1;
      return;
    }
    source = matches[0];
    if (matches.length > 1) {
      console.log(
        `Note: "${skillName}" is already installed on ${matches.length} platform(s); using the ${source.platform.label} copy as the source.`,
      );
    }
  } else {
    p.intro("skillfn link");
    source = await pickSourceInteractively(all);
    if (!source) {
      p.cancel("Cancelled.");
      return;
    }
  }

  let targets: PlatformInfo[];
  if (options.to) {
    targets =
      options.to === "all"
        ? PLATFORMS.filter((pl) => pl.id !== source!.platform.id)
        : [findPlatform(options.to)].filter((pl): pl is NonNullable<typeof pl> => Boolean(pl));
    if (targets.length === 0) {
      console.log(`Unknown target platform "${options.to}". Known platforms: ${PLATFORMS.map((pl) => pl.id).join(", ")}, or "all".`);
      process.exitCode = 1;
      return;
    }
  } else {
    const picked = await pickTargetsInteractively(source.platform.id);
    if (!picked) {
      p.cancel("Cancelled.");
      return;
    }
    targets = picked;
  }

  const signals = await sniffCapabilities(source.dir);
  const results: string[] = [];

  for (const target of targets) {
    if (target.id === source.platform.id) continue;

    if (source.scope === "global" && !target.globalDir) {
      results.push(
        `${target.label}: has no global skill directory (confirmed — project-local only). ` +
          `Run this from inside a project to link it there instead.`,
      );
      continue;
    }

    const targetRoot = source.scope === "global" ? target.globalDir!(homedir()) : target.projectDir(process.cwd());
    const targetPath = join(targetRoot, source.name);

    const alreadyExists = await lstat(targetPath).then(() => true, () => false);
    if (alreadyExists) {
      results.push(`${target.label}: already has a skill at ${targetPath} — skipping (no overwrite).`);
      continue;
    }

    await mkdir(targetRoot, { recursive: true });
    await symlink(source.dir, targetPath, "dir");
    let line = `${target.label}: linked (${targetPath} -> ${source.dir})`;

    if (signals.likelyNetwork) {
      if (target.networkPosture === "none") {
        line += `\n    WARNING: this skill appears to need network access, but ${target.label} skills get none — it will likely fail there.`;
      } else if (target.networkPosture === "configurable-sandbox") {
        line += `\n    Note: this skill appears to need network access. ${target.label}'s network access is sandbox-configurable — make sure its policy allows this skill's domains.`;
      } else if (target.networkPosture === undefined) {
        line += `\n    Note: this skill appears to need network access. ${target.label}'s network policy was not independently verified — check manually before relying on it.`;
      }
    }
    if (signals.likelyExec && target.networkPosture === undefined) {
      line += `\n    Note: this skill appears to execute shell commands. Verify ${target.label} permits that before relying on it.`;
    }
    results.push(line);
  }

  if (interactive) {
    for (const line of results) p.log.step(line);
    p.outro("Done.");
  } else {
    for (const line of results) console.log(`  ${line}`);
  }
}
