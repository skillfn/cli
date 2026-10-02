import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import YAML from "yaml";
import * as p from "@clack/prompts";
import { skillSpectorScanner, ScannerNotInstalledError } from "../scanner/skillSpectorScanner.js";
import type { ScanResult } from "../scanner/types.js";
import { toSarif } from "../sarif.js";
import { offerToInstallSkillSpector, manualInstallInstructions, type InstallOfferContext } from "../skillSpectorInstall.js";
import { passBanner } from "../ui.js";
import { findSkillsUnder, type FoundSkill } from "../skillTreeDiscovery.js";
import { discoverAllSkills } from "../skillDiscovery.js";
import { runAggregateScan, buildAggregatedSkill, type AggregateReport } from "../aggregateScan.js";
import { printAggregateReport, writeMarkdownReport } from "../scanReport.js";

export interface RunScanOptions {
  context?: InstallOfferContext;
  autoYes?: boolean;
}

/** Thrown when SkillSpector isn't installed and the user declined (or the install failed). */
export class SkillSpectorRequiredError extends Error {}

/**
 * SkillSpector's actual scan can take a while with zero output of its own, especially on
 * its first run right after a fresh `uv tool install` (cold Python interpreter start plus
 * importing its own fairly heavy dependency tree -- numpy, yara-python, tiktoken, etc.), so
 * a silent CLI here reads as "stalled" rather than "working." The `timer` indicator keeps
 * this to one line (current step + elapsed time, no verbose dump) instead of a bare
 * spinner. Output goes to stderr, never stdout, so --format json/sarif stays clean.
 */
async function scanWithSpinner(path: string): Promise<ScanResult> {
  const s = p.spinner({ output: process.stderr, indicator: "timer" });
  s.start("Scanning with SkillSpector");
  try {
    const result = await skillSpectorScanner.scan(path);
    s.stop("Scan complete.");
    return result;
  } catch (err) {
    // ScannerNotInstalledError isn't a failed scan -- it's the normal "not set up yet"
    // path the caller handles next (offering to install), so don't frame it as one.
    s.error(err instanceof ScannerNotInstalledError ? "SkillSpector isn't installed." : "Scan failed.");
    throw err;
  }
}

export async function runScan(path: string, options: RunScanOptions = {}): Promise<ScanResult> {
  try {
    return await scanWithSpinner(path);
  } catch (err) {
    if (err instanceof ScannerNotInstalledError) {
      const installed = await offerToInstallSkillSpector({
        context: options.context ?? "scan",
        autoYes: options.autoYes,
      });
      if (installed) {
        return await scanWithSpinner(path); // retry now that it's actually there
      }
      const instructions = (await manualInstallInstructions()).replace(/\n/g, "\n  ");
      throw new SkillSpectorRequiredError(
        `Skillfn requires SkillSpector to run a security scan. Install it with:\n  ${instructions}\nThen try again.`,
      );
    }
    throw err;
  }
}

/** Best-effort name/description for display -- a missing or malformed SKILL.md still lets
 * the scan itself run (the frontmatter isn't required for SkillSpector to work), it just
 * falls back to the directory name so the report always has something to show. */
async function readSkillMeta(path: string): Promise<{ name: string; description: string }> {
  try {
    const text = await readFile(join(path, "SKILL.md"), "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const front = YAML.parse(match[1]) as Record<string, unknown>;
      return { name: String(front.name ?? path), description: String(front.description ?? "") };
    }
  } catch {
    // fall through to the directory-name fallback below
  }
  return { name: path, description: "" };
}

/**
 * Single-skill terminal output now renders through the exact same per-skill template as a
 * multi-skill aggregate scan (one name/description/instance/risk-breakdown block, grouped
 * by severity) instead of a bespoke flat list -- consistent regardless of how many skills
 * were scanned. --format json/sarif are untouched: those are the stable, already-published
 * single-skill schema other tooling (GitHub Code Scanning, scripts) depends on.
 */
async function printSingleSkillTerminal(path: string, result: ScanResult, elapsedMs: number, options: { full?: boolean }): Promise<void> {
  const { name, description } = await readSkillMeta(path);
  const skill = buildAggregatedSkill(name, description, result.findings.map((finding) => ({ finding, dir: path })), [path]);
  console.log(`\n${chalk.dim("Scanner:")} ${result.scannerName}    ${chalk.dim("Risk score:")} ${result.riskScore}    ${chalk.dim("Result:")} ${passBanner(result.passed)}`);
  printAggregateReport({ skills: [skill], totalInstancesScanned: 1, scanErrors: 0, elapsedMs }, options);
}

interface ScanOptions {
  format?: "terminal" | "json" | "sarif";
  yes?: boolean;
  full?: boolean;
}

async function scanSinglePath(path: string, options: ScanOptions): Promise<void> {
  const start = Date.now();
  let result: ScanResult;
  try {
    result = await runScan(path, { context: "scan", autoYes: options.yes });
  } catch (err) {
    if (err instanceof SkillSpectorRequiredError) {
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const format = options.format ?? "terminal";

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (format === "sarif") {
    console.log(JSON.stringify(toSarif(result), null, 2));
  } else {
    await printSingleSkillTerminal(path, result, Date.now() - start, { full: options.full });
  }

  process.exitCode = result.passed ? 0 : 1;
}

async function hasSkillMdDirectly(path: string): Promise<boolean> {
  try {
    await access(join(path, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

async function runAggregateFlow(skills: FoundSkill[], options: ScanOptions): Promise<void> {
  const report = await runAggregateScan(skills);
  const format = options.format ?? "terminal";

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else if (format === "sarif") {
    console.error(
      "SARIF output isn't supported for a multi-skill scan yet -- scan an individual skill directory (the one with its own SKILL.md) for SARIF.",
    );
    process.exitCode = 1;
    return;
  } else {
    printAggregateReport(report, { full: options.full });
    await postReportMenu(report);
  }

  const hasBlocking = report.skills.some((s) => (s.severityCounts.critical ?? 0) > 0 || (s.severityCounts.high ?? 0) > 0);
  process.exitCode = hasBlocking ? 1 : 0;
}

async function postReportMenu(report: AggregateReport): Promise<void> {
  if (!process.stdin.isTTY) return;
  for (;;) {
    const choice = await p.select({
      message: "Want me to:",
      options: [
        { value: "markdown", label: "Generate a Markdown report (real collapsible sections -- open it in GitHub/VS Code)" },
        { value: "watch", label: "Set up a watcher for this folder" },
        { value: "done", label: "Done" },
      ],
    });
    if (p.isCancel(choice) || choice === "done") return;

    if (choice === "markdown") {
      const defaultPath = `skillfn-scan-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
      const out = await p.text({ message: "Write report to:", initialValue: defaultPath });
      if (p.isCancel(out)) continue;
      await writeMarkdownReport(report, out);
      p.log.success(`Wrote ${out}`);
    } else if (choice === "watch") {
      p.note(
        "'skillfn watch' currently watches every platform's known skill directories (global + the current project), not an arbitrary custom folder -- cd into the project you want watched and run it from there.",
        "Not wired up for a custom path yet",
      );
    }
  }
}

async function resolveTargetsForPath(path: string): Promise<FoundSkill[] | "single" | undefined> {
  if (await hasSkillMdDirectly(path)) return "single";
  const found = await findSkillsUnder(path);
  if (found.length === 0) {
    console.error(`No SKILL.md found directly in or under ${path}.`);
    return undefined;
  }
  // stderr, not stdout -- a diagnostic about *how* the scan was interpreted, not part of
  // the --format json/sarif machine-readable output.
  console.error(chalk.dim(`No SKILL.md directly in ${path} -- found ${found.length} skill(s) under it, scanning each individually.`));
  return found;
}

async function pickScanTargets(): Promise<{ mode: "single"; path: string } | { mode: "aggregate"; skills: FoundSkill[] } | undefined> {
  const choice = await p.select({
    message: "What do you want to scan?",
    options: [
      {
        value: "full",
        label: "Everywhere skillfn knows about",
        hint: "every known skill directory, global + this project, across every supported platform",
      },
      { value: "path", label: "A specific file or folder" },
      { value: "known", label: "Choose from skills already installed here" },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (p.isCancel(choice) || choice === "cancel") return undefined;

  if (choice === "full" || choice === "known") {
    const known = await discoverAllSkills();
    if (known.length === 0) {
      p.log.warn("No installed skills found across any known platform directory.");
      return undefined;
    }
    if (choice === "full") {
      return { mode: "aggregate", skills: known.map((s) => ({ name: s.name, description: s.description, dir: s.dir })) };
    }
    const picked = await p.multiselect({
      message: "Which skill(s)?",
      options: known.map((s) => ({ value: s.dir, label: `${s.name} (${s.platform.label})`, hint: s.description || undefined })),
      required: true,
    });
    if (p.isCancel(picked)) return undefined;
    const chosenDirs = new Set(picked as string[]);
    return { mode: "aggregate", skills: known.filter((s) => chosenDirs.has(s.dir)).map((s) => ({ name: s.name, description: s.description, dir: s.dir })) };
  }

  // choice === "path"
  const pathInput = await p.text({ message: "Path to scan:", validate: (v) => (v?.trim() ? undefined : "Required.") });
  if (p.isCancel(pathInput)) return undefined;
  const targets = await resolveTargetsForPath(pathInput.trim());
  if (targets === undefined) return undefined;
  return targets === "single" ? { mode: "single", path: pathInput.trim() } : { mode: "aggregate", skills: targets };
}

export async function scanCommand(path: string | undefined, options: ScanOptions): Promise<void> {
  if (path === undefined) {
    if (!process.stdin.isTTY) {
      console.error("A path is required when not running interactively: skillfn scan <path>");
      process.exitCode = 1;
      return;
    }
    p.intro("skillfn scan");
    const targets = await pickScanTargets();
    if (!targets) {
      p.cancel("Cancelled.");
      return;
    }
    if (targets.mode === "single") {
      await scanSinglePath(targets.path, options);
    } else {
      await runAggregateFlow(targets.skills, options);
    }
    return;
  }

  const targets = await resolveTargetsForPath(path);
  if (targets === undefined) {
    process.exitCode = 1;
    return;
  }
  if (targets === "single") {
    await scanSinglePath(path, options);
  } else {
    await runAggregateFlow(targets, options);
  }
}
