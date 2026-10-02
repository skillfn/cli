import { spawn } from "node:child_process";
import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadSession, HUB_URL } from "../session.js";
import { PLATFORMS } from "../platforms.js";
import { offerToInstallSkillSpector, manualInstallInstructions } from "../skillSpectorInstall.js";
import { heading, success, failure } from "../ui.js";

/**
 * `brew doctor`/`flutter doctor`-shaped diagnostics -- checks the things most likely to
 * cause a confusing failure before the user hits one.
 */

async function checkLine(label: string, check: () => Promise<string | undefined>): Promise<boolean> {
  const problem = await check();
  if (problem) {
    console.log(`  ${failure(`${label}: ${problem}`)}`);
    return false;
  }
  console.log(`  ${success(label)}`);
  return true;
}

function isSkillSpectorInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("skillspector", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function findDanglingLinks(): Promise<string[]> {
  const dangling: string[] = [];
  const home = homedir();
  const cwd = process.cwd();
  const roots = new Set<string>();
  for (const platform of PLATFORMS) {
    if (platform.globalDir) roots.add(platform.globalDir(home));
    roots.add(platform.projectDir(cwd));
  }

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // directory doesn't exist -- nothing to check
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const full = join(root, entry.name);
      try {
        await stat(full); // follows the symlink -- throws if the target is gone
      } catch {
        dangling.push(full);
      }
    }
  }
  return dangling;
}

interface DoctorOptions {
  yes?: boolean;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  console.log(`${heading("skillfn doctor")}\n`);

  const hasSkillSpector = await checkLine("skillspector on PATH", async () =>
    (await isSkillSpectorInstalled())
      ? undefined
      : `required, not found. Install:\n      ${(await manualInstallInstructions()).replace(/\n/g, "\n      ")}`,
  );
  if (!hasSkillSpector) {
    await offerToInstallSkillSpector({ context: "doctor", autoYes: options.yes });
  }

  await checkLine("hub session", async () => {
    const session = await loadSession();
    if (!session) return "not logged in -- run 'skillfn login' (or just 'skillfn publish', it triggers this automatically).";
    try {
      const res = await fetch(`${HUB_URL}/api/whoami`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      if (!res.ok) return "session token is invalid or expired -- run 'skillfn login' to refresh it.";
      const data = (await res.json()) as { userName: string };
      console.log(chalk.dim(`    (signed in as ${data.userName})`));
      return undefined;
    } catch {
      return `could not reach ${HUB_URL} to verify the session -- check your network connection.`;
    }
  });

  await checkLine("no dangling 'skillfn link' symlinks", async () => {
    const dangling = await findDanglingLinks();
    if (dangling.length === 0) return undefined;
    return `${dangling.length} broken symlink(s) found:\n` + dangling.map((d) => `      ${d}`).join("\n");
  });

  console.log();
}
