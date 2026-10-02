import type { AggregateReport } from "./aggregateScan.js";

/** Above this, a prompt stops being something you'd actually want to paste inline -- the
 * caller switches to writing a full Markdown report and pointing a short prompt at it. */
export const INLINE_PROMPT_MAX_CHARS = 4000;

export function totalFindingCount(report: AggregateReport): number {
  return report.skills.reduce((n, s) => n + s.totalFindings, 0);
}

/** A ready-to-paste prompt listing every real finding (never scanLimitations -- those are
 * scanner coverage notices, not something an agent can "fix") across every scanned skill. */
export function buildFixPrompt(report: AggregateReport): string {
  const lines: string[] = [
    "I ran skillfn (a SKILL.md security scanner) and it found the issue(s) below. Please fix them.",
    "",
  ];
  for (const skill of report.skills) {
    if (skill.uniqueRisks.length === 0) continue;
    lines.push(`## ${skill.name}`, `Path(s): ${skill.instances.join(", ")}`, "");
    for (const risk of skill.uniqueRisks) {
      lines.push(`- [${risk.severity.toUpperCase()}] ${risk.rule}: ${risk.message}`);
      if (risk.remediation) lines.push(`  Fix: ${risk.remediation}`);
      for (const loc of risk.locations) lines.push(`  - ${loc}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Short prompt pointing at a full Markdown report instead of inlining everything --
 * used once buildFixPrompt's output is too long to be a reasonable clipboard paste. */
export function buildReportPointerPrompt(report: AggregateReport, reportPath: string): string {
  const count = totalFindingCount(report);
  return (
    `I ran skillfn (a SKILL.md security scanner) and it found ${count} issue(s) -- too many to paste inline, ` +
    `so the full report is at ${reportPath}. Please read it and fix every issue it lists.`
  );
}
