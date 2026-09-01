import { skillSpectorScanner, ScannerNotInstalledError } from "../scanner/skillSpectorScanner.js";
import type { ScanResult } from "../scanner/types.js";
import { toSarif } from "../sarif.js";
import { offerToInstallSkillSpector, type InstallOfferContext } from "../skillSpectorInstall.js";

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

export interface RunScanOptions {
  context?: InstallOfferContext;
  autoYes?: boolean;
}

/**
 * SkillSpector is a hard requirement, not a nice-to-have with a fallback -- see
 * extra/plans/03-security-gate.md's 2026-09-01 correction. The removed `patternScanner`
 * was a strict, shallow subset of SkillSpector's 71-pattern/17-category coverage (confirmed
 * by direct comparison, not assumed) with zero unique value; presenting its weaker result
 * under the same "PASS" branding was a real quality-signaling problem for a trust product.
 */
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
      throw new SkillSpectorRequiredError(
        "Skillfn requires SkillSpector to run a security scan -- there is no weaker fallback. Install it with:\n" +
          "  uv tool install git+https://github.com/NVIDIA/skillspector.git\n" +
          "Then try again.",
      );
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
