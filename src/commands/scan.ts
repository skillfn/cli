import { patternScanner } from "../scanner/patternScanner.js";
import { skillSpectorScanner, ScannerNotInstalledError } from "../scanner/skillSpectorScanner.js";
import type { ScanResult } from "../scanner/types.js";
import { toSarif } from "../sarif.js";
import { offerToInstallSkillSpector, type InstallOfferContext } from "../skillSpectorInstall.js";

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

export interface RunScanOptions {
  context?: InstallOfferContext;
  autoYes?: boolean;
}

export async function runScan(path: string, options: RunScanOptions = {}): Promise<ScanResult> {
  try {
    return await skillSpectorScanner.scan(path);
  } catch (err) {
    if (err instanceof ScannerNotInstalledError) {
      // Diagnostic, not data -- always stderr, so --format json/sarif output on stdout
      // stays clean and pipeable (e.g. straight into a GitHub Code Scanning upload step).
      console.error(
        "NVIDIA SkillSpector is not installed (the primary v1 scan engine). " +
          "Falling back to the built-in pattern scanner, which covers fewer categories.\n" +
          "  Install it yourself anytime with: uv tool install git+https://github.com/NVIDIA/skillspector.git\n",
      );
      const installed = await offerToInstallSkillSpector({
        context: options.context ?? "scan",
        autoYes: options.autoYes,
      });
      if (installed) {
        return await skillSpectorScanner.scan(path); // retry now that it's actually there
      }
      return patternScanner.scan(path);
    }
    throw err;
  }
}

function printTerminal(path: string, result: ScanResult): void {
  console.log(`\nSkillfn scan — ${path}`);
  console.log(`Scanner: ${result.scannerName}`);
  console.log(`Risk score: ${result.riskScore}`);
  console.log(result.passed ? "Result: PASS" : "Result: FAIL");

  if (result.findings.length === 0) {
    console.log("\nNo findings.");
  } else {
    const sorted = [...result.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity),
    );
    console.log(`\nFindings (${sorted.length}):`);
    for (const f of sorted) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  [${f.severity.toUpperCase()}] ${f.rule} (${loc})`);
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
  const result = await runScan(path, { context: "scan", autoYes: options.yes });
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
