import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { getInstalledVersion, getLatestVersion, isNewer } from "../selfVersion.js";

function runCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

interface UpgradeOptions {
  yes?: boolean;
}

export async function upgradeCommand(options: UpgradeOptions = {}): Promise<void> {
  const current = await getInstalledVersion();
  const latest = await getLatestVersion();

  if (!latest) {
    console.log("Could not reach the npm registry to check for updates -- check your network connection.");
    process.exitCode = 1;
    return;
  }

  if (!isNewer(latest, current)) {
    console.log(`Already up to date (v${current}).`);
    return;
  }

  console.log(`A new version is available: v${current} -> v${latest}`);

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.log("Run 'npm install -g skillfn@latest' to update, or pass --yes to install it now non-interactively.");
      return;
    }
    const confirmed = await p.confirm({
      message: `Install skillfn@${latest} now (runs: npm install -g skillfn@latest)?`,
      initialValue: true,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Skipped -- run 'npm install -g skillfn@latest' yourself whenever you're ready.");
      return;
    }
  }

  const s = p.spinner();
  s.start(`Installing skillfn@${latest}`);
  const ok = await runCommand("npm", ["install", "-g", "skillfn@latest"]);
  s.stop(ok ? `Updated to v${latest}.` : "Update failed -- see output above.");
  if (!ok) process.exitCode = 1;
}
