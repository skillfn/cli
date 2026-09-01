import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

/**
 * Scaffolds a scan-clean SKILL.md skeleton from a short prompt. Exists to remove a real
 * funnel-friction point: a first-time author's first encounter with `skillfn scan` was
 * previously a cold, empty directory with no guidance -- this gives them a correct
 * starting point instead (extra/plans/09-growth-funnel-and-business-model.md).
 */

function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function initCommand(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rawName = await rl.question("Skill name: ");
    const name = toKebabCase(rawName);
    if (!name) {
      console.log("A name is required.");
      process.exitCode = 1;
      return;
    }

    const description = (await rl.question("One-line description: ")).trim();
    if (!description) {
      console.log("A description is required.");
      process.exitCode = 1;
      return;
    }

    const needsNetwork = (await rl.question("Does this skill need network access? [y/N]: "))
      .trim()
      .toLowerCase()
      .startsWith("y");
    const needsExec = (await rl.question("Does this skill run shell commands/scripts? [y/N]: "))
      .trim()
      .toLowerCase()
      .startsWith("y");

    const dir = join(process.cwd(), name);
    try {
      await access(dir);
      console.log(`\n"${dir}" already exists -- not overwriting.`);
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
description: ${description}
---

# ${rawName.trim()}
${capabilityLine}
## Instructions

<!-- Describe, step by step, what the agent should do when this skill is triggered. -->
`;

    await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");

    console.log(`\nCreated ${join(dir, "SKILL.md")}.`);
    console.log(`Next: edit it, then run 'skillfn scan ${name}' before publishing.\n`);
  } finally {
    rl.close();
  }
}
