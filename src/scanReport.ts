import { writeFile } from "node:fs/promises";
import chalk from "chalk";
import type { Severity } from "./scanner/types.js";
import type { AggregateReport, AggregatedSkill, UniqueRisk } from "./aggregateScan.js";
import { heading, colorSeverity } from "./ui.js";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const ALWAYS_DETAILED: ReadonlySet<Severity> = new Set(["critical", "high"]);

function formatBreakdown(counts: Partial<Record<Severity, number>>): string {
  return SEVERITY_ORDER.filter((sev) => counts[sev])
    .map((sev) => `${counts[sev]} ${colorSeverity(sev)}`)
    .join(chalk.dim(" · ")) || chalk.dim("none");
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatRisks(risks: UniqueRisk[], full: boolean): string[] {
  const lines: string[] = [];
  const grouped = new Map<Severity, UniqueRisk[]>();
  for (const r of risks) grouped.set(r.severity, [...(grouped.get(r.severity) ?? []), r]);

  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev);
    if (!group || group.length === 0) continue;
    if (!full && !ALWAYS_DETAILED.has(sev)) {
      lines.push(`    [${colorSeverity(sev)}] ${chalk.dim(`${group.length} finding(s) -- rerun with --full to see them`)}`);
      continue;
    }
    lines.push(`    [${colorSeverity(sev)}]`);
    for (const r of group) {
      const occurrence = r.count > 1 ? chalk.dim(` (${r.count}x)`) : "";
      lines.push(`      - ${r.message}${occurrence}`);
      const shown = r.locations.slice(0, 3).join(", ");
      const more = r.count > r.locations.length ? chalk.dim(`, +${r.count - r.locations.length} more`) : "";
      lines.push(`        ${chalk.dim(`${r.rule} — ${shown}${more}`)}`);
    }
  }
  return lines;
}

/** One skill's block, as lines -- shared by the static full-report printer and live
 * per-skill streaming (aggregateScan.ts's onSkillReady), so both render identically. */
export function formatSkillBlock(skill: AggregatedSkill, options: { full?: boolean } = {}): string {
  const lines: string[] = [heading(skill.name)];
  if (skill.description) lines.push(`  ${chalk.dim(skill.description)}`);
  lines.push(`  used in: ${skill.instances.length} instance(s)`);
  for (const dir of skill.instances) lines.push(`    - ${chalk.dim(dir)}`);
  lines.push(`  risk breakdown: ${formatBreakdown(skill.severityCounts)}`);
  if (skill.uniqueRisks.length > 0) {
    lines.push(`  risks & issues:`, ...formatRisks(skill.uniqueRisks, options.full ?? false));
  }
  lines.push("");
  return lines.join("\n");
}

export function formatSummaryBlock(report: AggregateReport): string {
  const totals: Partial<Record<Severity, number>> = {};
  for (const skill of report.skills) {
    for (const sev of SEVERITY_ORDER) totals[sev] = (totals[sev] ?? 0) + (skill.severityCounts[sev] ?? 0);
  }
  const instanceCount = new Set(report.skills.flatMap((s) => s.instances)).size;

  const lines = [
    heading("Summary"),
    `  scanned: ${report.skills.length} skill(s) across ${instanceCount} instance(s)/director${instanceCount === 1 ? "y" : "ies"}`,
    `  runtime: ${formatElapsed(report.elapsedMs)}`,
    `  breakdown: ${formatBreakdown(totals)}`,
  ];
  if (report.scanErrors > 0) {
    lines.push(chalk.dim(`  (${report.scanErrors} instance(s) failed to scan and were skipped)`));
  }
  lines.push("");
  return lines.join("\n");
}

export function printAggregateReport(report: AggregateReport, options: { full?: boolean } = {}): void {
  console.log();
  for (const skill of report.skills) console.log(formatSkillBlock(skill, options));
  console.log(formatSummaryBlock(report));
}

function escapeMd(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Markdown's own <details>/<summary> gives real, working expand/collapse when viewed on
 * GitHub, VS Code's preview, or any renderer that supports raw HTML in Markdown -- unlike
 * a terminal, which can't do this without a full TUI rewrite. */
export function buildMarkdownReport(report: AggregateReport): string {
  const lines: string[] = [];
  lines.push(`# Skillfn scan report`, "");
  lines.push(`Generated ${new Date().toISOString()}`, "");

  const totals: Partial<Record<Severity, number>> = {};
  for (const skill of report.skills) {
    for (const sev of SEVERITY_ORDER) totals[sev] = (totals[sev] ?? 0) + (skill.severityCounts[sev] ?? 0);
  }
  const instanceCount = new Set(report.skills.flatMap((s) => s.instances)).size;
  lines.push(
    `**Scanned:** ${report.skills.length} skill(s) across ${instanceCount} instance(s)  `,
    `**Runtime:** ${formatElapsed(report.elapsedMs)}  `,
    `**Breakdown:** ${SEVERITY_ORDER.filter((s) => totals[s]).map((s) => `${totals[s]} ${s.toUpperCase()}`).join(", ") || "none"}`,
    "",
    "---",
    "",
  );

  for (const skill of report.skills) {
    lines.push(`## ${escapeMd(skill.name)}`, "");
    if (skill.description) lines.push(`${escapeMd(skill.description)}`, "");
    lines.push(`**Used in ${skill.instances.length} instance(s):**`);
    for (const dir of skill.instances) lines.push(`- \`${dir}\``);
    lines.push("");
    lines.push(
      `**Risk breakdown:** ${SEVERITY_ORDER.filter((s) => skill.severityCounts[s]).map((s) => `${skill.severityCounts[s]} ${s.toUpperCase()}`).join(", ") || "none"}`,
      "",
    );

    const grouped = new Map<Severity, UniqueRisk[]>();
    for (const r of skill.uniqueRisks) grouped.set(r.severity, [...(grouped.get(r.severity) ?? []), r]);
    for (const sev of SEVERITY_ORDER) {
      const group = grouped.get(sev);
      if (!group || group.length === 0) continue;
      lines.push(`<details>`, `<summary><strong>${sev.toUpperCase()}</strong> (${group.length})</summary>`, "");
      for (const r of group) {
        const occurrence = r.count > 1 ? ` (${r.count}x)` : "";
        lines.push(`- ${escapeMd(r.message)}${occurrence} — \`${r.rule}\``);
        for (const loc of r.locations) lines.push(`  - \`${loc}\``);
        if (r.count > r.locations.length) lines.push(`  - _+${r.count - r.locations.length} more_`);
      }
      lines.push("", `</details>`, "");
    }
    lines.push("---", "");
  }

  return lines.join("\n");
}

export async function writeMarkdownReport(report: AggregateReport, path: string): Promise<void> {
  await writeFile(path, buildMarkdownReport(report), "utf8");
}
