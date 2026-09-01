import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";

/**
 * Scaffolds a scan-clean SKILL.md skeleton from a short prompt. Exists to remove a real
 * funnel-friction point: a first-time author's first encounter with `skillfn scan` was
 * previously a cold, empty directory with no guidance -- this gives them a correct
 * starting point instead.
 */

function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function initCommand(): Promise<void> {
  p.intro("skillfn init");

  const rawName = await p.text({
    message: "Skill name:",
    validate: (value) => (toKebabCase(value ?? "") ? undefined : "A name is required."),
  });
  if (p.isCancel(rawName)) return void p.cancel("Cancelled.");
  const name = toKebabCase(rawName);

  const description = await p.text({
    message: "One-line description:",
    validate: (value) => (value?.trim() ? undefined : "A description is required."),
  });
  if (p.isCancel(description)) return void p.cancel("Cancelled.");

  const needsNetwork = await p.confirm({ message: "Does this skill need network access?", initialValue: false });
  if (p.isCancel(needsNetwork)) return void p.cancel("Cancelled.");

  const needsExec = await p.confirm({ message: "Does this skill run shell commands/scripts?", initialValue: false });
  if (p.isCancel(needsExec)) return void p.cancel("Cancelled.");

  const dir = join(process.cwd(), name);
  try {
    await access(dir);
    p.cancel(`"${dir}" already exists -- not overwriting.`);
    process.exitCode = 1;
    return;
  } catch {
    // doesn't exist yet, good
  }

  await mkdir(dir, { recursive: true });

  const capabilityLine =
    needsNetwork || needsExec
      ? `\nThis skill ${[needsNetwork && "makes network requests", needsExec && "runs shell commands"].filter(Boolean).join(" and ")}.\n`
      : "";

  const skillMd = `---
name: ${name}
description: ${description.trim()}
---

# ${rawName.trim()}
${capabilityLine}
## Instructions

<!-- Describe, step by step, what the agent should do when this skill is triggered. -->
`;

  await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");

  p.outro(`Created ${join(dir, "SKILL.md")}. Next: edit it, then run 'skillfn scan ${name}' before publishing.`);
}
