import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

/**
 * Interactive, opt-in install offer for NVIDIA SkillSpector -- deliberately NOT a
 * postinstall script. A postinstall-based auto-install was considered and rejected
 * (2026-09-01): security-hardened environments commonly run `npm install --ignore-scripts`
 * (exactly this product's target audience), global installs are frequently run under sudo
 * (interactive prompts + spawning a Python toolchain installer as root inside postinstall is
 * the well-known node-sass/node-gyp category of pain), and non-interactive/piped install
 * contexts can't sensibly prompt at all. Offering this at the moment it actually matters
 * (a real scan/publish attempt) instead keeps `npm install -g skillfn` itself fast, Node-only,
 * and impossible to break via an unrelated toolchain failure -- same "ask at a genuine value
 * moment, never force" principle already used for the publish-prompts consent design.
 */

const INSTALL_CMD = "uv";
const INSTALL_ARGS = ["tool", "install", "git+https://github.com/NVIDIA/skillspector.git"];

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // never hang a non-interactive/piped context
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n]: `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function runInstall(): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\nRunning: ${INSTALL_CMD} ${INSTALL_ARGS.join(" ")}\n`);
    const child = spawn(INSTALL_CMD, INSTALL_ARGS, { stdio: "inherit" });
    child.on("error", () => {
      // 'uv' itself missing is a different, one-level-further dependency -- we ask the user
      // to install that themselves too, rather than compounding the trust chain by having
      // OUR installer fetch and run ANOTHER installer on their behalf unprompted.
      console.error(
        "\n'uv' isn't installed -- SkillSpector needs it. Install uv yourself first: " +
          "https://docs.astral.sh/uv/getting-started/installation/, then try again.\n",
      );
      resolve(false);
    });
    child.on("close", (code) => resolve(code === 0));
  });
}

export type InstallOfferContext = "scan" | "publish" | "doctor";

export interface InstallOfferOptions {
  /** Skip the interactive prompt and proceed as if the user said yes -- e.g. a --yes flag. */
  autoYes?: boolean;
  /** publish/update frame this more insistently -- the RESULT, not just the scan, is weaker. */
  context: InstallOfferContext;
}

/** Returns true if SkillSpector ended up installed (already was, or the offer just succeeded). */
export async function offerToInstallSkillSpector(options: InstallOfferOptions): Promise<boolean> {
  const message =
    options.context === "publish"
      ? "SkillSpector (the primary scanner) isn't installed -- publishing now would only be backed by the weaker fallback scanner, not the real security gate. Install it now?"
      : "SkillSpector (the primary scanner) isn't installed. Install it now for a stronger check?";

  const proceed = options.autoYes || (await promptYesNo(message));
  if (!proceed) return false;

  const ok = await runInstall();
  if (ok) console.log("\nSkillSpector installed.\n");
  return ok;
}
