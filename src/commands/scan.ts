import chalk from "chalk";
import { skillSpectorScanner, ScannerNotInstalledError } from "../scanner/skillSpectorScanner.js";
import type { ScanResult } from "../scanner/types.js";
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

export async function runScan(path: string, options: RunScanOptions = {}): Promise<ScanResult> {
  try {
    return await skillSpectorScanner.scan(path);
  } catch (err) {
    if (err instanceof ScannerNotInstalledError) {
      // Diagnostic, not data -- always stderr, so --format json/sarif output on stdout
      // stays clean and pipeable (e.g. straight into a GitHub Code Scanning upload step).
      console.error("NVIDIA SkillSpector is required and isn't installed.\n");
      const installed = await offerToInstallSkillSpector({
        context: options.context ?? "scan",
        autoYes: options.autoYes,
      });
      if (installed) {
        return await skillSpectorScanner.scan(path); // retry now that it's actually there
      }
      const instructions = (await manualInstallInstructions()).replace(/\n/g, "\n  ");
      throw new SkillSpectorRequiredError(
        `Skillfn requires SkillSpector to run a security scan. Install it with:\n  ${instructions}\nThen try again.`,
      );
    }
    throw err;
  }
}

function printTerminal(path: string, result: ScanResult): void {
  console.log(`\n${chalk.bold("Skillfn scan")} — ${chalk.dim(path)}`);
  console.log(`${chalk.dim("Scanner:")} ${result.scannerName}`);
  console.log(`${chalk.dim("Risk score:")} ${result.riskScore}`);
  console.log(`${chalk.dim("Result:")} ${passBanner(result.passed)}`);

  if (result.findings.length === 0) {
    console.log(chalk.dim("\nNo findings."));
  } else {
    const sorted = [...result.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity),
    );
    console.log(chalk.bold(`\nFindings (${sorted.length}):`));
    for (const f of sorted) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  ${colorSeverity(f.severity)} ${f.rule} ${chalk.dim(`(${loc})`)}`);
      console.log(`    ${f.message}`);
    }
  }
  console.log();
}

interface ScanOptions {
  format?: "terminal" | "json" | "sarif";
  yes?: boolean;
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
    printTerminal(path, result);
  }

  process.exitCode = result.passed ? 0 : 1;
}
