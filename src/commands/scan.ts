import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import YAML from "yaml";
import * as p from "@clack/prompts";
import { skillSpectorScanner, ScannerNotInstalledError } from "../scanner/skillSpectorScanner.js";
import type { ScanResult } from "../scanner/types.js";
import { toSarif } from "../sarif.js";
import { offerToInstallSkillSpector, manualInstallInstructions, type InstallOfferContext } from "../skillSpectorInstall.js";
import { passBanner, skillListLabel, truncateHint } from "../ui.js";
import { findSkillsUnder, type FoundSkill, type OrphanedSkillFolder } from "../skillTreeDiscovery.js";
import { findSkillMdFilename, offerRenameToCanonical, CANONICAL_SKILL_MD } from "../skillMdFile.js";
import { discoverAllSkills } from "../skillDiscovery.js";
import { runAggregateScan, buildAggregatedSkill, mergeReferenceChecks, type AggregateReport, type AggregatedReferenceCheck } from "../aggregateScan.js";
import { anyReferenceCheck, checkSkillReferences, NO_REFERENCE_CHECKS, type ReferenceCheckOptions } from "../brokenReferences.js";
import { printAggregateReport, formatSkillBlock, formatSummaryBlock, writeMarkdownReport } from "../scanReport.js";

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
  s.start("Scanning with skillfn");
  try {
    const result = await skillSpectorScanner.scan(path);
    s.stop("Scan complete.");
    return result;
  } catch (err) {
    // ScannerNotInstalledError isn't a failed scan -- it's the normal "not set up yet"
    // path the caller handles next (offering to install), so don't frame it as one. Kept
    // generic here (the underlying scanner's exact name only matters once we're actually
    // telling the user what to install, a few lines down) -- the routine narration a user
    // sees on every scan should say skillfn, not repeat a dependency's name every time.
    s.error(err instanceof ScannerNotInstalledError ? "Security scanner isn't installed." : "Scan failed.");
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
    const filename = await findSkillMdFilename(path);
    if (!filename) return { name: path, description: "" };
    const text = await readFile(join(path, filename), "utf8");
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
async function printSingleSkillTerminal(
  path: string,
  result: ScanResult,
  elapsedMs: number,
  options: { full?: boolean },
  referenceCheck?: AggregatedReferenceCheck,
): Promise<void> {
  const { name, description } = await readSkillMeta(path);
  // Read fresh, after resolveTargetsForPath's rename offer already had its chance --
  // reflects whichever name is actually in effect now (renamed or left as-is).
  const currentFilename = await findSkillMdFilename(path);
  const nonCanonical = currentFilename && currentFilename !== CANONICAL_SKILL_MD ? [`${path}/${currentFilename}`] : [];
  const skill = buildAggregatedSkill(
    name,
    description,
    result.findings.map((finding) => ({ finding, dir: path })),
    [path],
    [result.completeness],
    nonCanonical,
    referenceCheck,
  );
  // No "Scanner: nvidia-skillspector" line here -- which engine ran is in --format json's
  // scannerName for tooling that cares, not routine terminal narration; the aggregate
  // report (scanReport.ts) never showed it either, so this is consistent either way.
  console.log(`\n${chalk.dim("Risk score:")} ${result.riskScore}    ${chalk.dim("Result:")} ${passBanner(result.passed)}`);
  printAggregateReport({ skills: [skill], totalInstancesScanned: 1, scanErrors: 0, elapsedMs }, options);
}

interface ScanOptions {
  format?: "terminal" | "json" | "sarif";
  yes?: boolean;
  full?: boolean;
  /** Commander's shape for `--check-references [level]` + `--no-check-references`:
   * true (bare flag), "links" | "all", false (negated), or undefined (neither given). */
  checkReferences?: boolean | string;
  checkUrls?: boolean;
  /** Resolved from the flags/prompt in scanCommand; never set by Commander itself. */
  referenceChecks?: ReferenceCheckOptions;
}

class InvalidReferenceFlagError extends Error {}

/** Spinner only when the URL check is on -- that's the one part that can take real time
 * with nothing else on screen; the filesystem checks finish near-instantly. */
async function runReferenceCheck(path: string, checks: ReferenceCheckOptions): Promise<AggregatedReferenceCheck> {
  const s = checks.urls ? p.spinner({ output: process.stderr, indicator: "timer" }) : undefined;
  s?.start("Checking references");
  try {
    return mergeReferenceChecks(checks, [await checkSkillReferences(path, checks)]);
  } finally {
    s?.stop("Checked references.");
  }
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
  const checks = options.referenceChecks ?? NO_REFERENCE_CHECKS;
  const referenceCheck = anyReferenceCheck(checks) && format !== "sarif" ? await runReferenceCheck(path, checks) : undefined;

  if (format === "json") {
    // Additive and absent unless asked for, so the single-skill JSON schema other tooling
    // already consumes is unchanged by default.
    console.log(JSON.stringify(referenceCheck ? { ...result, referenceCheck } : result, null, 2));
  } else if (format === "sarif") {
    console.log(JSON.stringify(toSarif(result), null, 2));
  } else {
    await printSingleSkillTerminal(path, result, Date.now() - start, { full: options.full }, referenceCheck);
  }

  process.exitCode = result.passed ? 0 : 1;
}

async function runAggregateFlow(skills: FoundSkill[], options: ScanOptions): Promise<void> {
  const format = options.format ?? "terminal";

  if (format === "sarif") {
    console.error(
      "SARIF output isn't supported for a multi-skill scan yet -- scan an individual skill directory (the one with its own SKILL.md) for SARIF.",
    );
    process.exitCode = 1;
    return;
  }

  // Terminal mode streams each skill's block to stdout the instant it's ready (riding the
  // same stream as the live progress footer, so they can't race into a corrupted screen --
  // see ThreadedProgress.print) instead of waiting for the whole batch to finish. json mode
  // collects everything and serializes it at the end, so the progress footer stays on
  // stderr and nothing streams, keeping stdout pure JSON.
  const streaming = format === "terminal";
  const report = await runAggregateScan(skills, {
    referenceChecks: options.referenceChecks,
    progressOutput: streaming ? process.stdout : process.stderr,
    onSkillReady: streaming ? (skill) => formatSkillBlock(skill, { full: options.full }) : undefined,
  });

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSummaryBlock(report));
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
        { value: "markdown", label: "Generate a Markdown report", hint: "collapsible sections, viewable in GitHub/VS Code" },
        { value: "watch", label: "Set up a watcher for this folder", hint: "coming soon" },
        { value: "done", label: "Done" },
      ],
    });
    if (p.isCancel(choice) || choice === "done") return;

    if (choice === "watch") {
      p.log.info("Coming soon.");
      continue;
    }

    const defaultPath = `skillfn-scan-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const out = await p.text({ message: "Write report to:", initialValue: defaultPath });
    if (p.isCancel(out)) continue;
    await writeMarkdownReport(report, out);
    p.log.success(`Wrote ${out}`);
  }
}

function printOrphanedFolders(orphaned: OrphanedSkillFolder[]): void {
  if (orphaned.length === 0) return;
  console.error(
    chalk.dim(
      `${orphaned.length} folder(s) look like they might be a skill missing its manifest (heuristic -- verify manually):`,
    ),
  );
  for (const o of orphaned) {
    console.error(chalk.dim(`  - ${o.dir} (has: ${o.signals.join(", ")})`));
  }
}

async function resolveTargetsForPath(path: string): Promise<FoundSkill[] | "single" | undefined> {
  const directFilename = await findSkillMdFilename(path);
  if (directFilename) {
    await offerRenameToCanonical(path, directFilename);
    return "single";
  }

  const { skills: found, orphaned } = await findSkillsUnder(path);
  if (found.length === 0) {
    console.error(`No SKILL.md found directly in or under ${path}.`);
    printOrphanedFolders(orphaned);
    return undefined;
  }
  // stderr, not stdout -- a diagnostic about *how* the scan was interpreted, not part of
  // the --format json/sarif machine-readable output.
  console.error(chalk.dim(`No SKILL.md directly in ${path} -- found ${found.length} skill(s) under it, scanning each individually.`));
  printOrphanedFolders(orphaned);

  for (const skill of found) {
    skill.manifestFilename = await offerRenameToCanonical(skill.dir, skill.manifestFilename);
  }
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
      // Bulk mode: just report non-canonical filenames in the final output (see
      // aggregateScan.ts's nonCanonicalManifests) rather than interactively asking about
      // each one -- a serial confirm-per-skill tax doesn't make sense across potentially
      // dozens of skills the user didn't individually pick.
      return {
        mode: "aggregate",
        skills: known.map((s) => ({ name: s.name, description: s.description, dir: s.dir, manifestFilename: s.manifestFilename })),
      };
    }
    const picked = await p.multiselect({
      message: "Which skill(s)?",
      options: known.map((s) => ({
        value: s.dir,
        label: skillListLabel(s.name, s.platform.label),
        hint: s.description ? truncateHint(s.description) : undefined,
      })),
      required: true,
    });
    if (p.isCancel(picked)) return undefined;
    const chosenDirs = new Set(picked as string[]);
    const chosen = known.filter((s) => chosenDirs.has(s.dir));
    for (const s of chosen) {
      s.manifestFilename = await offerRenameToCanonical(s.dir, s.manifestFilename);
    }
    return {
      mode: "aggregate",
      skills: chosen.map((s) => ({ name: s.name, description: s.description, dir: s.dir, manifestFilename: s.manifestFilename })),
    };
  }

  // choice === "path"
  const pathInput = await p.text({ message: "Path to scan:", validate: (v) => (v?.trim() ? undefined : "Required.") });
  if (p.isCancel(pathInput)) return undefined;
  const targets = await resolveTargetsForPath(pathInput.trim());
  if (targets === undefined) return undefined;
  return targets === "single" ? { mode: "single", path: pathInput.trim() } : { mode: "aggregate", skills: targets };
}

/**
 * Asks once, right after the scan target is known, instead of requiring --full to be
 * remembered and typed -- only when it'd actually change anything: a script/CI context
 * (non-TTY), an explicit --full/--no-full, or a machine-readable --format all already have
 * their answer, so none of those get interrupted by a prompt.
 */
async function resolveFullDetail(options: ScanOptions): Promise<boolean> {
  if (options.full !== undefined) return options.full;
  if ((options.format ?? "terminal") !== "terminal" || !process.stdin.isTTY) return false;

  const choice = await p.select({
    message: "How much detail?",
    options: [
      { value: "normal", label: "Normal", hint: "critical/high in full, everything else as a count" },
      { value: "full", label: "Full detail", hint: "show every finding" },
    ],
  });
  return !p.isCancel(choice) && choice === "full";
}

/**
 * Turns --check-references / --no-check-references / --check-urls into the three switches.
 * Returns undefined when none was given, meaning "ask" (see resolveReferenceChecks).
 * `--check-references` alone means links only -- the precise tier -- and `=all` adds the
 * heuristic prose/code-block tier; URLs are never implied by either, since they need the network.
 */
function referenceChecksFromFlags(options: ScanOptions): ReferenceCheckOptions | undefined {
  if (options.checkReferences === undefined && options.checkUrls === undefined) return undefined;
  const level = options.checkReferences;
  if (typeof level === "string" && level !== "links" && level !== "all") {
    throw new InvalidReferenceFlagError(`--check-references accepts "links" or "all" (got "${level}").`);
  }
  return {
    links: level === true || level === "links" || level === "all",
    prose: level === "all",
    urls: options.checkUrls === true,
  };
}

/**
 * Same interactive pattern as resolveFullDetail: ask once, only when it would change
 * anything. Off unless chosen -- this check is heuristic-prone compared to the scanner's
 * findings, and the URL part makes network requests, so neither is ever a silent default.
 * Scripts/CI (non-TTY) and machine-readable formats get "off" without a prompt.
 */
async function resolveReferenceChecks(options: ScanOptions): Promise<ReferenceCheckOptions> {
  const fromFlags = referenceChecksFromFlags(options);
  if (fromFlags) return fromFlags;
  if ((options.format ?? "terminal") !== "terminal" || !process.stdin.isTTY) return NO_REFERENCE_CHECKS;

  const choices = await p.multiselect({
    message: "Extra checks? (space to toggle, enter to skip)",
    options: [
      { value: "links", label: "Broken local links", hint: "markdown links/images pointing at files that don't exist" },
      { value: "prose", label: "Path mentions in prose & code blocks", hint: "heuristic -- can flag example paths" },
      { value: "urls", label: "External URLs", hint: "makes network requests" },
    ],
    required: false,
  });
  if (p.isCancel(choices)) return NO_REFERENCE_CHECKS;
  const picked = new Set(choices as string[]);
  return { links: picked.has("links"), prose: picked.has("prose"), urls: picked.has("urls") };
}

export async function scanCommand(path: string | undefined, options: ScanOptions): Promise<void> {
  try {
    referenceChecksFromFlags(options);
  } catch (err) {
    if (!(err instanceof InvalidReferenceFlagError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  let targets: { mode: "single"; path: string } | { mode: "aggregate"; skills: FoundSkill[] };

  if (path === undefined) {
    if (!process.stdin.isTTY) {
      console.error("A path is required when not running interactively: skillfn scan <path>");
      process.exitCode = 1;
      return;
    }
    p.intro("skillfn scan");
    const picked = await pickScanTargets();
    if (!picked) {
      p.cancel("Cancelled.");
      return;
    }
    targets = picked;
  } else {
    const resolved = await resolveTargetsForPath(path);
    if (resolved === undefined) {
      process.exitCode = 1;
      return;
    }
    targets = resolved === "single" ? { mode: "single", path } : { mode: "aggregate", skills: resolved };
  }

  const finalOptions = { ...options, full: await resolveFullDetail(options), referenceChecks: await resolveReferenceChecks(options) };
  if (targets.mode === "single") {
    await scanSinglePath(targets.path, finalOptions);
  } else {
    await runAggregateFlow(targets.skills, finalOptions);
  }
}
