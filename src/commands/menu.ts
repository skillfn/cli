import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { printBanner } from "../asciiArt.js";
import { getInstalledVersion } from "../selfVersion.js";

interface MenuItem {
  value: string;
  label: string;
  hint: string;
  /** Prompted for and appended as an extra positional arg before re-running the command --
   * only the handful of commands with a required path/id argument need this. */
  promptArg?: { message: string; placeholder?: string };
}

const ITEMS: MenuItem[] = [
  { value: "scan", label: "Scan", hint: "run the local security scanner" },
  { value: "audit", label: "Audit", hint: "find unused or duplicate installed skills" },
  { value: "link", label: "Link", hint: "share a skill with another platform" },
  { value: "watch", label: "Watch", hint: "nudge toward publishing new local skills" },
  {
    value: "publish",
    label: "Publish",
    hint: "scan, sign, and publish a skill to the hub",
    promptArg: { message: "Path to the skill to publish:", placeholder: "./my-skill" },
  },
  {
    value: "update",
    label: "Update",
    hint: "publish a new version of an already-published skill",
    promptArg: { message: "Path to the skill to update:", placeholder: "./my-skill" },
  },
  { value: "doctor", label: "Doctor", hint: "diagnose common setup problems" },
  { value: "init", label: "Init", hint: "scaffold a new SKILL.md" },
  { value: "login", label: "Login", hint: "sign in to the hub" },
  { value: "upgrade", label: "Upgrade", hint: "check npm for a newer skillfn release" },
];

/**
 * The bare `skillfn` entrypoint -- an interactive menu over the same subcommands
 * documented in `skillfn --help`, for people who'd rather arrow-key through their options
 * than remember exact flag syntax. Re-invokes the real CLI entry (same binary, chosen
 * subcommand as argv) via execFileSync rather than calling each command's action function
 * directly, so this never drifts from -- or duplicates -- that command's own argument
 * parsing, option handling, or behavior.
 */
export async function menuCommand(): Promise<void> {
  const version = await getInstalledVersion();
  printBanner(version, process.cwd());

  // No subcommand to fall back to non-interactively here (unlike e.g. `scan`/`link` with no
  // arguments) -- a non-interactive invocation (CI, piped input) gets a pointer to --help
  // instead of a prompt nothing can answer.
  if (!process.stdin.isTTY) {
    console.log("Not an interactive terminal -- run 'skillfn --help' to see available commands.");
    return;
  }

  const choice = await p.select({
    message: "What do you want to do?",
    options: [
      ...ITEMS.map((item) => ({ value: item.value, label: item.label, hint: item.hint })),
      { value: "exit", label: "Exit", hint: "do nothing" },
    ],
  });
  if (p.isCancel(choice) || choice === "exit") return;

  // Also covers a non-interactive/closed stdin (no TTY to answer the select from): clack
  // doesn't always resolve that as an explicit cancel, so `choice` can come back as
  // something other than one of ITEMS' values -- treat that the same as cancelling.
  const item = ITEMS.find((i) => i.value === choice);
  if (!item) return;
  const args = [item.value];

  if (item.promptArg) {
    const arg = await p.text({ message: item.promptArg.message, placeholder: item.promptArg.placeholder });
    if (p.isCancel(arg) || !arg.trim()) return;
    args.push(arg.trim());
  }

  execFileSync(process.execPath, [process.argv[1], ...args], { stdio: "inherit" });
}
