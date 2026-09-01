export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  /** Mapping to a public taxonomy (OWASP Agentic AI Top 10 / MITRE ATLAS), filled in as rules mature.
   * See extra/plans/03-security-gate.md. */
  taxonomy?: string;
}

export interface ScanResult {
  scannerName: string;
  passed: boolean;
  riskScore: number;
  findings: Finding[];
}

/**
 * A pluggable scan engine. `skillSpectorScanner` is the sole v1 implementation --
 * SkillSpector is a hard requirement, not one option among several (see
 * extra/plans/03-security-gate.md's 2026-09-01 correction: the previous fallback,
 * `patternScanner`, was a confirmed-redundant subset of SkillSpector's coverage and was
 * removed). Further engines can be added later behind this same interface for
 * multi-scanner *consensus* (extra/plans/07-roadmap.md, Phase 7) — a genuinely different
 * goal from "fallback when the primary is missing" — do not couple calling code to a
 * specific implementation.
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

/** A skill fails the gate if any finding is high/critical — see extra/plans/03-security-gate.md. */
export function decidePass(findings: Finding[]): boolean {
  return !findings.some((f) => f.severity === "high" || f.severity === "critical");
}

export function computeRiskScore(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
}
