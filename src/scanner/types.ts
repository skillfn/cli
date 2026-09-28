export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  /** Mapping to a public taxonomy (OWASP Agentic AI Top 10 / MITRE ATLAS), filled in as rules mature. */
  taxonomy?: string;
}

export interface ScanResult {
  scannerName: string;
  passed: boolean;
  riskScore: number;
  findings: Finding[];
}

/**
 * A pluggable scan engine. `skillSpectorScanner` is the sole implementation today.
 * Further engines can be added later behind this same interface for multi-scanner
 * consensus — do not couple calling code to a specific implementation.
 */
export interface Scanner {
  name: string;
  scan(skillDir: string): Promise<ScanResult>;
}

/** Weights used to turn findings into a single risk score and pass/fail decision. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 3,
  high: 7,
  critical: 15,
};

/** A skill fails the gate if any finding is high/critical. */
export function decidePass(findings: Finding[]): boolean {
  return !findings.some((f) => f.severity === "high" || f.severity === "critical");
}

export function computeRiskScore(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
}
