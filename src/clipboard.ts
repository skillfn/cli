import { spawn } from "node:child_process";

/**
 * Cross-platform clipboard write via whatever native tool is already on the system --
 * deliberately not a new npm dependency (clipboardy et al. pull their own dependency tree)
 * for something this small, and skillfn already runs fine on modest hardware without it.
 * Tries each known tool in turn; a tool that isn't installed just fails fast (ENOENT) and
 * the next one is tried. Returns false, never throws, when nothing on the system can do it
 * (e.g. a headless/SSH session with no clipboard tool) -- callers fall back to printing the
 * text for the user to copy by hand.
 */
function trySpawnCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {}); // a not-found command can close stdin before we finish writing
    child.stdin.end(text);
  });
}

const CANDIDATES: Array<{ cmd: string; args: string[] }> =
  process.platform === "darwin"
    ? [{ cmd: "pbcopy", args: [] }]
    : process.platform === "win32"
      ? [{ cmd: "clip", args: [] }]
      : [
          { cmd: "wl-copy", args: [] },
          { cmd: "xclip", args: ["-selection", "clipboard"] },
          { cmd: "xsel", args: ["--clipboard", "--input"] },
        ];

export async function copyToClipboard(text: string): Promise<boolean> {
  for (const { cmd, args } of CANDIDATES) {
    if (await trySpawnCopy(cmd, args, text)) return true;
  }
  return false;
}
