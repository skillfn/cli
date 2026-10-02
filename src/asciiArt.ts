import chalk from "chalk";

/**
 * A small padlock glyph -- skillfn's whole job is a security gate in front of SKILL.md
 * files, so a lock reads as on-brand without needing a real logo asset or an extra font/
 * ASCII-art dependency (figlet etc.) for a banner that's shown once per interactive session.
 */
const LOCK = [
  "  ▄▄▄▄▄  ",
  " █     █ ",
  " █     █ ",
  "█████████",
  "█       █",
  "█  ███  █",
  "█       █",
  "█████████",
];

/**
 * Prints the banner shown by the bare `skillfn` menu -- real data only (version, cwd):
 * no invented "recent activity" feed, since skillfn doesn't track one.
 */
export function printBanner(version: string, cwd: string): void {
  const lock = LOCK.map((line) => chalk.cyan(line));
  const info = [
    "",
    chalk.bold(`skillfn ${chalk.dim(`v${version}`)}`),
    chalk.dim("scan, sign, and publish AI agent skills"),
    "",
    chalk.dim(cwd),
    "",
  ];
  const height = Math.max(lock.length, info.length);
  const lockWidth = 9;
  for (let i = 0; i < height; i++) {
    const left = (lock[i] ?? " ".repeat(lockWidth)).padEnd(lockWidth + 2);
    const right = info[i] ?? "";
    console.log(`  ${left}${right}`);
  }
  console.log();
}
