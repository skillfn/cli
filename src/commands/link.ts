import { mkdir, lstat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverAllSkills } from "../skillDiscovery.js";
import { PLATFORMS, findPlatform } from "../platforms.js";
import { sniffCapabilities } from "../capabilitySignals.js";

interface LinkOptions {
  to: string;
}

export async function linkCommand(skillName: string, options: LinkOptions): Promise<void> {
  const all = await discoverAllSkills();
  const matches = all.filter((s) => s.name === skillName);

  if (matches.length === 0) {
    console.log(
      `No installed skill named "${skillName}" found across confirmed platforms (${PLATFORMS.map((p) => p.label).join(", ")}).`,
    );
    process.exitCode = 1;
    return;
  }

  const source = matches[0];
  if (matches.length > 1) {
    console.log(
      `Note: "${skillName}" is already installed on ${matches.length} platform(s); using the ${source.platform.label} copy as the source.`,
    );
  }

  const targets =
    options.to === "all"
      ? PLATFORMS.filter((p) => p.id !== source.platform.id)
      : [findPlatform(options.to)].filter((p): p is NonNullable<typeof p> => Boolean(p));

  if (targets.length === 0) {
    console.log(
      `Unknown target platform "${options.to}". Known platforms: ${PLATFORMS.map((p) => p.id).join(", ")}, or "all".`,
    );
    process.exitCode = 1;
    return;
  }

  const signals = await sniffCapabilities(source.dir);

  for (const target of targets) {
    if (target.id === source.platform.id) continue;

    if (source.scope === "global" && !target.globalDir) {
      console.log(
        `  ${target.label}: has no global skill directory (confirmed — project-local only). ` +
          `Run this from inside a project to link it there instead.`,
      );
      continue;
    }

    const targetRoot =
      source.scope === "global" ? target.globalDir!(homedir()) : target.projectDir(process.cwd());
    const targetPath = join(targetRoot, skillName);

    const alreadyExists = await lstat(targetPath).then(() => true, () => false);
    if (alreadyExists) {
      console.log(`  ${target.label}: already has a skill at ${targetPath} — skipping (no overwrite).`);
      continue;
    }

    await mkdir(targetRoot, { recursive: true });
    await symlink(source.dir, targetPath, "dir");
    console.log(`  ${target.label}: linked (${targetPath} -> ${source.dir})`);

    if (signals.likelyNetwork) {
      if (target.networkPosture === "none") {
        console.log(
          `    WARNING: this skill appears to need network access, but ${target.label} skills get none — it will likely fail there.`,
        );
      } else if (target.networkPosture === "configurable-sandbox") {
        console.log(
          `    Note: this skill appears to need network access. ${target.label}'s network access is sandbox-configurable — make sure its policy allows this skill's domains.`,
        );
      } else if (target.networkPosture === undefined) {
        console.log(
          `    Note: this skill appears to need network access. ${target.label}'s network policy was not independently verified — check manually before relying on it.`,
        );
      }
    }
    if (signals.likelyExec && target.networkPosture === undefined) {
      console.log(
        `    Note: this skill appears to execute shell commands. Verify ${target.label} permits that before relying on it.`,
      );
    }
  }
}
