export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Kept separate from `message` (SkillSpector reports them as distinct fields) so
   * terminal/Markdown output can render it as its own sub-line/section instead of one
   * run-on sentence. */
  remediation?: string;
  file: string;
  line?: number;
  /** Mapping to a public taxonomy (OWASP Agentic AI Top 10 / MITRE ATLAS), filled in as rules mature. */
  taxonomy?: string;
  /**
   * True for a finding that reports the SCANNER's own inability to fully inspect
   * something (e.g. SkillSpector's "AE1: referenced artifact was not completely
   * inspected" when a file exceeds its analysis size/bounds) -- not a claim that the
   * skill IS doing something risky. Confirmed from a real scan where this showed up tagged
   * "high" severity and would otherwise have failed the gate and inflated the severity
   * breakdown purely because the scanner hit a size limit, with zero evidence of anything
   * malicious. Excluded from decidePass/computeRiskScore and reported separately.
   */
  isCoverageLimitation?: boolean;
}

/**
 * SkillSpector's own `analysis_completeness` projection (confirmed field, see
 * inspection_ledger.py's AnalysisCompleteness) -- an explicit, authoritative signal for
 * "did the scan actually finish," instead of a human having to infer it by eyeballing
 * AE1/coverage-limitation finding counts. Optional because other scanners (the pluggable
 * Scanner interface) have no equivalent concept to report.
 */
export interface AnalysisCompleteness {
  isComplete: boolean;
  status: string;
  coveragePercent: number;
  fullyInspectedFiles: number;
  partiallyInspectedFiles: number;
  entirelyUninspectedFiles: number;
  /**
   * SkillSpector's own human-readable explanation(s) for why it isn't complete -- e.g.
   * "Analyzer static_patterns_supply_chain status: degraded." when its dependency
   * vulnerability lookup (api.osv.dev) couldn't be reached. Confirmed real case: 100%
   * coveragePercent (every file fully read) with isComplete still false, purely because
   * that one external network call failed -- a content-truncation message like "some
   * content wasn't inspected" would be factually wrong there. Surfacing this verbatim
   * instead of guessing a cause (and a generic fix) from coveragePercent alone.
   */
  limitations: string[];
}

export interface ScanResult {
  scannerName: string;
  passed: boolean;
  riskScore: number;
  findings: Finding[];
  completeness?: AnalysisCompleteness;
  /** Findings suppressed by a reviewed baseline (see suppression.ts) -- already excluded
   * from `findings`/riskScore/passed by the scanner itself, kept here only as a count so a
   * report can say "N reviewed finding(s) not shown" instead of making it look like they
   * were never found at all. */
  suppressedCount?: number;
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

/** A skill fails the gate if any finding is high/critical -- a coverage-limitation finding
 * (the scanner couldn't fully inspect something) is never grounds for failing on its own,
 * since it isn't evidence the skill is doing anything risky. */
export function decidePass(findings: Finding[]): boolean {
  return !findings.some((f) => !f.isCoverageLimitation && (f.severity === "high" || f.severity === "critical"));
}

export function computeRiskScore(findings: Finding[]): number {
  return findings.filter((f) => !f.isCoverageLimitation).reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
}
