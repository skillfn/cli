import type { Finding, ScanResult, Severity } from "./scanner/types.js";

/**
 * Minimal SARIF 2.1.0 serialization -- lets `skillfn scan --format sarif` output plug
 * directly into GitHub Code Scanning (PR annotations) and VS Code's Problems panel with
 * zero extra work on either end. NVIDIA SkillSpector already supports `--format sarif`
 * natively; this covers the `patternScanner` fallback path, which doesn't.
 */

function severityToSarifLevel(severity: Severity): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function ruleIds(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))];
}

export function toSarif(result: ScanResult): object {
  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: result.scannerName,
            // No real domain purchased yet (skillfn.vercel.app today; a .com is planned
            // once the hub becomes more social-network-shaped -- see 00-MASTERPLAN.md).
            informationUri: "https://skillfn.vercel.app",
            rules: ruleIds(result.findings).map((id) => ({ id })),
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.rule,
          level: severityToSarifLevel(f.severity),
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                ...(f.line ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
        })),
      },
    ],
  };
}
