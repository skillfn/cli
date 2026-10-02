import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";

/**
 * Interactive install offer for `uv` + NVIDIA SkillSpector, both required. Deliberately NOT
 * a postinstall script -- security-hardened environments commonly run
 * `npm install --ignore-scripts` (this tool's own target audience), global installs are
 * frequently run under sudo, and non-interactive/piped install contexts can't sensibly
 * prompt at all. Offering this at the moment it actually matters keeps `npm install -g
 * skillfn` itself fast, Node-only, and impossible to break via an unrelated toolchain
 * failure.
 *
 * Uses arrow-key menus (`@clack/prompts`) rather than raw yes/no text -- most people
 * installing a CLI today are not comfortable following manual terminal instructions, and
 * shouldn't need to be to get a working setup.
 */

const UV_INSTALL_UNIX = { cmd: "sh", args: ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"] };
const UV_INSTALL_WINDOWS = {
  cmd: "powershell",
  args: ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"],
};
const UV_INSTALL_MANUAL_COMMAND =
  process.platform === "win32"
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    : "curl -LsSf https://astral.sh/uv/install.sh | sh";

const SKILLSPECTOR_INSTALL_ARGS = ["tool", "install", "git+https://github.com/NVIDIA/skillspector.git"];

function commandWorks(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * uv's own installer places the binary in ~/.local/bin and may only take effect in a new
 * shell session (confirmed against uv's official docs, 2026-09-02) -- so immediately after
 * running the installer, a bare `uv` on PATH can still fail even though it worked. Fall back
 * to the documented default location before giving up.
 */
function uvKnownPath(): string {
  return process.platform === "win32" ? join(homedir(), ".local", "bin", "uv.exe") : join(homedir(), ".local", "bin", "uv");
}

async function resolveUvCommand(): Promise<string | undefined> {
  if (await commandWorks("uv")) return "uv";
  const known = uvKnownPath();
  if (await commandWorks(known)) return known;
  return undefined;
}

function runCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export type InstallOfferContext = "scan" | "publish" | "doctor";

export interface InstallOfferOptions {
  /** Skip the interactive menu and proceed as if "install for me" was chosen -- e.g. --yes. */
  autoYes?: boolean;
  context: InstallOfferContext;
}

/**
 * The real install instructions, accounting for whether `uv` is ALSO missing -- used
 * both for the silent non-interactive bail-out below and for the generic
 * SkillSpectorRequiredError message in scan.ts. Previously those hardcoded just the
 * `uv tool install ...` line unconditionally, which fails with "command not found" and
 * no further guidance when `uv` itself isn't on the machine yet.
 */
export async function manualInstallInstructions(): Promise<string> {
  const skillspectorLine = `uv tool install git+https://github.com/NVIDIA/skillspector.git`;
  const uvCmd = await resolveUvCommand();
  return uvCmd ? skillspectorLine : `${UV_INSTALL_MANUAL_COMMAND}\n${skillspectorLine}`;
}

async function runWithSpinner(label: string, cmd: string, args: string[]): Promise<boolean> {
  const s = p.spinner();
  s.start(`Installing ${label}`);
  const ok = await runCommand(cmd, args);
  s.stop(ok ? `${label} installed.` : `${label} install failed -- see output above.`);
  return ok;
}

/** Returns true if SkillSpector ended up installed (already was, or the offer just succeeded). */
export async function offerToInstallSkillSpector(options: InstallOfferOptions): Promise<boolean> {
  if (await commandWorks("skillspector")) return true;
  if (!process.stdin.isTTY && !options.autoYes) {
    // Never hang a non-interactive/piped context -- but say why, and with the real
    // instructions (including the `uv` step if that's missing too), instead of bailing
    // silently and leaving the caller's generic fallback message to possibly assume `uv`
    // is already installed when it isn't.
    console.error(
      "Not running interactively (no TTY) and --yes wasn't passed, so skillfn won't install " +
        "anything automatically. Run this yourself, then try again:\n  " +
        (await manualInstallInstructions()).replace(/\n/g, "\n  "),
    );
    return false;
  }

  const uvCmd = await resolveUvCommand();

  if (!uvCmd) {
    const uvInstall = process.platform === "win32" ? UV_INSTALL_WINDOWS : UV_INSTALL_UNIX;

    if (options.autoYes) {
      const ok = await runWithSpinner("uv", uvInstall.cmd, uvInstall.args);
      if (!ok) return false;
    } else {
      const choice = await p.select({
        message: "SkillSpector (the required security scanner) needs `uv`, a Python tool manager -- neither is installed yet.",
        options: [
          { value: "auto", label: "Install both uv and SkillSpector for me" },
          { value: "manual", label: "Just show me the commands, I'll run them myself" },
          { value: "cancel", label: "Cancel" },
        ],
      });

      if (p.isCancel(choice) || choice === "cancel") {
        p.cancel("Skipped -- scan/publish/update won't work until this is installed.");
        return false;
      }
      if (choice === "manual") {
        p.note(
          `${UV_INSTALL_MANUAL_COMMAND}\nuv tool install git+https://github.com/NVIDIA/skillspector.git`,
          "Run these, then try again",
        );
        return false;
      }
      const ok = await runWithSpinner("uv", uvInstall.cmd, uvInstall.args);
      if (!ok) return false;
    }

    const resolvedAfterInstall = await resolveUvCommand();
    if (!resolvedAfterInstall) {
      p.log.warn("uv was installed, but this terminal session can't see it yet -- open a new terminal and run 'skillfn doctor' to finish.");
      return false;
    }
    return runWithSpinner("SkillSpector", resolvedAfterInstall, SKILLSPECTOR_INSTALL_ARGS);
  }

  // uv is present, only SkillSpector is missing.
  if (options.autoYes) {
    return runWithSpinner("SkillSpector", uvCmd, SKILLSPECTOR_INSTALL_ARGS);
  }

  const choice = await p.select({
    message: "SkillSpector (the required security scanner) isn't installed.",
    options: [
      { value: "auto", label: "Install it for me" },
      { value: "manual", label: "Just show me the command, I'll run it myself" },
      { value: "cancel", label: "Cancel" },
    ],
  });

  if (p.isCancel(choice) || choice === "cancel") {
    p.cancel("Skipped -- scan/publish/update won't work until this is installed.");
    return false;
  }
  if (choice === "manual") {
    p.note(`${uvCmd} tool install git+https://github.com/NVIDIA/skillspector.git`, "Run this, then try again");
    return false;
  }
  return runWithSpinner("SkillSpector", uvCmd, SKILLSPECTOR_INSTALL_ARGS);
}
