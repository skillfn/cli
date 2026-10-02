import chalk from "chalk";
import * as p from "@clack/prompts";
import { skillSpectorScanner, ScannerNotInstalledError } from "../scanner/skillSpectorScanner.js";
import type { ScanResult, Severity } from "../scanner/types.js";
import { toSarif } from "../sarif.js";
import { offerToInstallSkillSpector, manualInstallInstructions, type InstallOfferContext } from "../skillSpectorInstall.js";
import { colorSeverity, passBanner } from "../ui.js";

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

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

// Printed in full by default; everything below this is collapsed to a count unless --full
// is passed. A scan over a large tree (a whole skills library, not one SKILL.md) can
// return hundreds of low-signal findings that push the CRITICAL/HIGH ones -- the ones
// that actually need a look -- off the top of a terminal's scrollback before anyone can
// read them. Counts-first, detail-on-demand keeps the thing you need most visible.
const ALWAYS_DETAILED: ReadonlySet<Severity> = new Set(["critical", "high"]);

export function printTerminal(path: string, result: ScanResult, options: { full?: boolean } = {}): void {
  console.log(`\n${chalk.bold("Skillfn scan")} — ${chalk.dim(path)}`);
  console.log(`${chalk.dim("Scanner:")} ${result.scannerName}`);
  console.log(`${chalk.dim("Risk score:")} ${result.riskScore}`);
  console.log(`${chalk.dim("Result:")} ${passBanner(result.passed)}`);

  if (result.findings.length === 0) {
    console.log(chalk.dim("\nNo findings."));
    console.log();
    return;
  }

  const counts = new Map<Severity, number>();
  for (const f of result.findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const summary = SEVERITY_ORDER
    .slice()
    .reverse()
    .filter((sev) => counts.has(sev))
    .map((sev) => `${counts.get(sev)} ${colorSeverity(sev)}`)
    .join(chalk.dim(" · "));
  console.log(`${chalk.dim("Findings:")} ${result.findings.length} total (${summary})`);

  const sorted = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity),
  );
  const detailed = options.full ? sorted : sorted.filter((f) => ALWAYS_DETAILED.has(f.severity));
  const collapsed = sorted.length - detailed.length;

  if (detailed.length > 0) {
    console.log(chalk.bold(`\n${options.full ? "All findings" : "Critical/high findings"} (${detailed.length}):`));
    for (const f of detailed) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  ${colorSeverity(f.severity)} ${f.rule} ${chalk.dim(`(${loc})`)}`);
      console.log(`    ${f.message}`);
    }
  }
  if (collapsed > 0) {
    console.log(chalk.dim(`\n${collapsed} lower-severity finding(s) not shown -- rerun with --full to see them, or --format json for everything.`));
  }
  console.log();
}

interface ScanOptions {
  format?: "terminal" | "json" | "sarif";
  yes?: boolean;
  full?: boolean;
}

export async function scanCommand(path: string, options: ScanOptions): Promise<void> {
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
    printTerminal(path, result, { full: options.full });
  }

  process.exitCode = result.passed ? 0 : 1;
}
