import chalk from "chalk";
import { homedir } from "node:os";
import { sep } from "node:path";

const GREEN = "#A8F05A";
const PURPLE = "#C28BFF";
const BORDER = "#3B5142";
const LEFT_WIDTH = 25;
const RIGHT_WIDTH = 43;
const FULL_WIDTH = LEFT_WIDTH + RIGHT_WIDTH + 5; // borders, divider, and indent
const SLOGAN_TOP = "Security, Governance & Provenance";
const SLOGAN_BOTTOM = "for AI Agent Skills";
const SLOGAN = `${SLOGAN_TOP} ${SLOGAN_BOTTOM}`;

/** One pixel is two terminal columns, keeping the mascot square in monospace fonts. */
const BEACON = [
  ".GG.....GG.",
  "GGG.GGG.GGG",
  "GGGGGGGGGGG",
  "GGGGPGPGGGG",
  "..GGGGGGG..",
  "...GGGGG...",
  "....G.G....",
];

const border = (text: string): string => chalk.hex(BORDER)(text);
const green = (text: string): string => chalk.hex(GREEN)(text);

function beaconRow(row: string): string {
  return [...row].map((pixel) => {
    if (pixel === "G") return green("██");
    if (pixel === "P") return chalk.hex(PURPLE)("██");
    return "  ";
  }).join("");
}

function clipPath(cwd: string, width: number): string {
  const home = homedir();
  const display = cwd === home ? "~" : cwd.startsWith(`${home}${sep}`) ? `~${cwd.slice(home.length)}` : cwd;
  const safe = display.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  return safe.length > width ? `…${safe.slice(-(width - 1))}` : safe;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const current = lines.at(-1);
    if (current && current.length + 1 + word.length <= width) lines[lines.length - 1] = `${current} ${word}`;
    else lines.push(word);
  }
  return lines;
}

function printWideBanner(version: string, cwd: string): void {
  const leftBlank = " ".repeat(22);
  const line = (left: string, right: string, rightLength: number): void => {
    console.log(`  ${border("│")} ${left}  ${border("│")} ${right}${" ".repeat(RIGHT_WIDTH - 1 - rightLength)}${border("│")}`);
  };

  console.log(`  ${border(`╭${"─".repeat(LEFT_WIDTH)}┬${"─".repeat(RIGHT_WIDTH)}╮`)}`);
  line(leftBlank, green("SKILLFN / TERMINAL"), 18);

  const versionText = `v${version}`;
  const name = "skillfn_";
  const gap = Math.max(1, RIGHT_WIDTH - 1 - name.length - versionText.length);
  line(beaconRow(BEACON[0]), `${chalk.bold("skillfn")}${green("_")}${" ".repeat(gap)}${chalk.dim(versionText)}`, name.length + gap + versionText.length);
  line(beaconRow(BEACON[1]), SLOGAN_TOP, SLOGAN_TOP.length);
  line(beaconRow(BEACON[2]), SLOGAN_BOTTOM, SLOGAN_BOTTOM.length);
  console.log(`  ${border("│")} ${beaconRow(BEACON[3])}  ${border(`├${"─".repeat(RIGHT_WIDTH)}┤`)}`);
  line(beaconRow(BEACON[4]), green("WORKSPACE"), 9);
  const path = clipPath(cwd, RIGHT_WIDTH - 2);
  line(beaconRow(BEACON[5]), path, path.length);
  const capabilities = "SCAN  ·  SIGN  ·  PUBLISH";
  line(beaconRow(BEACON[6]), chalk.dim(capabilities), capabilities.length);
  console.log(`  ${border(`╰${"─".repeat(LEFT_WIDTH)}┴${"─".repeat(RIGHT_WIDTH)}╯`)}`);
}

function printCompactBanner(version: string, cwd: string, columns: number): void {
  const width = Math.min(43, columns - 4);
  if (width < 23) {
    console.log(`  ${chalk.bold("skillfn")}${green("_")} ${chalk.dim(`v${version}`)}`);
    for (const line of wrapText(SLOGAN, Math.max(10, columns - 2))) console.log(`  ${chalk.dim(line)}`);
    return;
  }

  const row = (text: string, visibleLength: number): void => {
    console.log(`  ${border("│")}${text}${" ".repeat(Math.max(0, width - visibleLength))}${border("│")}`);
  };
  console.log(`  ${border(`╭${"─".repeat(width)}╮`)}`);
  for (const pixels of BEACON) {
    const padding = " ".repeat(Math.floor((width - 22) / 2));
    row(`${padding}${beaconRow(pixels)}`, padding.length + 22);
  }
  row(` ${chalk.bold("skillfn")}${green("_")} ${chalk.dim(`v${version}`)}`, 11 + version.length);
  for (const line of wrapText(SLOGAN, width - 2)) row(` ${line}`, 1 + line.length);
  const path = clipPath(cwd, width - 2);
  row(` ${chalk.dim(path)}`, 1 + path.length);
  console.log(`  ${border(`╰${"─".repeat(width)}╯`)}`);
}

/** Prints the bare `skillfn` menu banner using the installed version and current directory. */
export function printBanner(version: string, cwd: string): void {
  const columns = process.stdout.columns ?? 80;
  if (columns >= FULL_WIDTH) printWideBanner(version, cwd);
  else printCompactBanner(version, cwd, columns);
  console.log();
}
