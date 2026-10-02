import { writeFile } from "node:fs/promises";
import chalk from "chalk";
import type { Severity } from "./scanner/types.js";
import type { AggregateReport, AggregatedSkill, UniqueRisk } from "./aggregateScan.js";
import { heading, dim, warn, colorSeverity } from "./ui.js";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const ALWAYS_DETAILED: ReadonlySet<Severity> = new Set(["critical", "high"]);
// Display-layer cap only -- UniqueRisk.locations itself is always the complete, uncapped
// list (see aggregateScan.ts); --format json and the Markdown report always get everything.
const MAX_LOCATIONS_DISPLAYED = 3;

/**
 * Box-drawing tree connectors -- reddit-style nested replies, applied to a skill's findings:
 * skill -> severity group -> risk -> (location / remediation) each get their own thread
 * instead of being crammed into one run-on line. `prefix` is the accumulated indentation
 * from every ancestor branch; `isLast` decides this line's own connector (├─/╰─) and the
 * prefix its own children inherit (│  to keep the sibling's line alive below, or three
 * spaces once there's nothing left to connect to).
 *
 * The closing corner (╰) is the rounded glyph, not the sharp one (└) -- the same one
 * @clack/prompts itself already uses for its own box/note corners (S_CORNER_BOTTOM_LEFT),
 * just not in the plain intro/outro bars you see around a `skillfn scan` session. Matching
 * it keeps the tree visually part of the same tool instead of looking like a second style
 * bolted on.
 */
const BRANCH = "├─ ";
const LAST_BRANCH = "╰─ ";
const PIPE = "│  ";
const GAP = "   ";

/** Marks each skill's own heading line -- @clack/prompts' own "confirmed step" glyph
 * (S_STEP_ACTIVE), reused here rather than a plain bullet so a skill reads as a distinct
 * top-level item in the same visual language the rest of the CLI's prompts already use. */
const SKILL_ICON = "◆";

function treeLine(prefix: string, isLast: boolean, text: string): string {
  return `${prefix}${isLast ? LAST_BRANCH : BRANCH}${text}`;
}

function childPrefix(prefix: string, isLast: boolean): string {
  return prefix + (isLast ? GAP : PIPE);
}

function formatBreakdown(counts: Partial<Record<Severity, number>>): string {
  return SEVERITY_ORDER.filter((sev) => counts[sev])
    .map((sev) => `${counts[sev]} ${colorSeverity(sev)}`)
    .join(chalk.dim(" · ")) || chalk.dim("none");
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Builds the incompleteness explanation from what SkillSpector actually said, instead of
 * guessing a cause (and a one-size-fits-all fix). Confirmed real case: a scan can come back
 * with LOW coveragePercent purely because one external network call (its dependency-
 * vulnerability lookup against api.osv.dev) was blocked/failed -- nothing to do with size or
 * time, so coveragePercent alone can't distinguish the two causes. scanLimitations (the
 * AE1-style "referenced artifact not completely inspected" findings) is the reliable signal
 * instead: those only ever arise from genuine content/size truncation, never from an
 * analyzer-level network failure, so the timeout suggestion is keyed on that, not on coverage.
 */
function incompleteSummary(skill: AggregatedSkill): string {
  const pct = skill.coveragePercent !== undefined ? ` (${skill.coveragePercent.toFixed(0)}% coverage)` : "";
  const reason = skill.incompleteReasons.length > 0 ? skill.incompleteReasons.join("; ") : "some content wasn't inspected";
  const seeBelow = skill.scanLimitations.length > 0 ? ` See "scan limitations" below.` : "";
  const suggestion = skill.scanLimitations.length > 0
    ? " Try SKILLSPECTOR_MAX_WORKFLOW_SECONDS=3600 (seconds) if this is a large skill."
    : "";
  return `Scan did not fully complete${pct} -- ${reason}.${seeBelow}${suggestion}`;
}

function formatRiskTree(risks: UniqueRisk[], full: boolean, prefix: string): string[] {
  const lines: string[] = [];
  const grouped = new Map<Severity, UniqueRisk[]>();
  for (const r of risks) grouped.set(r.severity, [...(grouped.get(r.severity) ?? []), r]);
  const severities = SEVERITY_ORDER.filter((sev) => grouped.has(sev));

  severities.forEach((sev, sevIndex) => {
    const group = grouped.get(sev)!;
    const sevIsLast = sevIndex === severities.length - 1;

    if (!full && !ALWAYS_DETAILED.has(sev)) {
      lines.push(treeLine(prefix, sevIsLast, `[${colorSeverity(sev)}] ${chalk.dim(`${group.length} finding(s) -- rerun with --full to see them`)}`));
      return;
    }

    lines.push(treeLine(prefix, sevIsLast, `[${colorSeverity(sev)}]`));
    const sevChildPrefix = childPrefix(prefix, sevIsLast);

    group.forEach((r, rIndex) => {
      const rIsLast = rIndex === group.length - 1;
      const occurrence = r.count > 1 ? chalk.dim(` (${r.count}x)`) : "";
      lines.push(treeLine(sevChildPrefix, rIsLast, `${r.message}${occurrence}`));

      const riskChildPrefix = childPrefix(sevChildPrefix, rIsLast);
      const shown = r.locations.slice(0, MAX_LOCATIONS_DISPLAYED).join(", ");
      const more = r.locations.length > MAX_LOCATIONS_DISPLAYED ? chalk.dim(`, +${r.locations.length - MAX_LOCATIONS_DISPLAYED} more`) : "";
      const subLines = [chalk.dim(`${r.rule} — ${shown}${more}`)];
      if (r.remediation) subLines.push(`${chalk.green("Remediation:")} ${r.remediation}`);
      subLines.forEach((text, i) => lines.push(treeLine(riskChildPrefix, i === subLines.length - 1, text)));
    });
  });
  return lines;
}

/** One skill's block, as lines -- shared by the static full-report printer and live
 * per-skill streaming (aggregateScan.ts's onSkillReady), so both render identically. */
export function formatSkillBlock(skill: AggregatedSkill, options: { full?: boolean } = {}): string {
  const lines: string[] = [heading(`${SKILL_ICON} ${skill.name}`)];
  if (skill.incomplete) {
    lines.push(warn(incompleteSummary(skill)));
  }
  for (const path of skill.nonCanonicalManifests) {
    lines.push(warn(`${path} isn't named exactly "SKILL.md" -- some tools on a case-sensitive filesystem won't find it. Rename it to fix.`));
  }

  const topLevel: Array<{ text: string; children?: (prefix: string) => string[] }> = [];
  if (skill.description) topLevel.push({ text: chalk.dim(skill.description) });
  topLevel.push({
    text: `used in: ${skill.instances.length} instance(s)`,
    children: (prefix) => skill.instances.map((dir, i) => treeLine(prefix, i === skill.instances.length - 1, chalk.dim(dir))),
  });
  topLevel.push({ text: `risk breakdown: ${formatBreakdown(skill.severityCounts)}` });
  if (skill.uniqueRisks.length > 0) {
    topLevel.push({ text: "risks & issues", children: (prefix) => formatRiskTree(skill.uniqueRisks, options.full ?? false, prefix) });
  }
  if (skill.scanLimitations.length > 0) {
    // Deliberately NOT part of "risk breakdown"/"risks & issues" above -- these are the
    // scanner reporting its own coverage gaps ("couldn't fully inspect X"), not a claim
    // about the skill's behavior, so they're visually demoted (dim) and labeled as such
    // rather than inflating the severity numbers a reader would otherwise trust.
    topLevel.push({
      text: dim(`scan limitations (${skill.scanLimitations.length} -- not security findings, see below)`),
      children: (prefix) =>
        skill.scanLimitations.flatMap((r, i) => {
          const isLast = i === skill.scanLimitations.length - 1;
          const occurrence = r.count > 1 ? ` (${r.count}x)` : "";
          return [treeLine(prefix, isLast, dim(`${r.message}${occurrence} — ${r.rule}`))];
        }),
    });
  }

  topLevel.forEach((item, i) => {
    const isLast = i === topLevel.length - 1;
    lines.push(treeLine("", isLast, item.text));
    if (item.children) lines.push(...item.children(childPrefix("", isLast)));
  });

  lines.push("");
  return lines.join("\n");
}

export function formatSummaryBlock(report: AggregateReport): string {
  const totals: Partial<Record<Severity, number>> = {};
  for (const skill of report.skills) {
    for (const sev of SEVERITY_ORDER) totals[sev] = (totals[sev] ?? 0) + (skill.severityCounts[sev] ?? 0);
  }
  const instanceCount = new Set(report.skills.flatMap((s) => s.instances)).size;

  const items = [
    `scanned: ${report.skills.length} skill(s) across ${instanceCount} instance(s)/director${instanceCount === 1 ? "y" : "ies"}`,
    `runtime: ${formatElapsed(report.elapsedMs)}`,
    `breakdown: ${formatBreakdown(totals)}`,
  ];
  if (report.scanErrors > 0) {
    items.push(chalk.dim(`${report.scanErrors} instance(s) failed to scan and were skipped`));
  }

  const lines = [heading("Summary"), ...items.map((text, i) => treeLine("", i === items.length - 1, text))];
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
    if (skill.incomplete) {
      lines.push(`> ⚠️ ${escapeMd(incompleteSummary(skill))}`, "");
    }
    for (const path of skill.nonCanonicalManifests) {
      lines.push(
        `> ⚠️ \`${path}\` isn't named exactly \`SKILL.md\` -- some tools on a case-sensitive filesystem won't find it. Rename it to fix.`,
        "",
      );
    }
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
        if (r.remediation) lines.push(`  - **Remediation:** ${escapeMd(r.remediation)}`);
      }
      lines.push("", `</details>`, "");
    }

    if (skill.scanLimitations.length > 0) {
      lines.push(
        `<details>`,
        `<summary>Scan limitations (${skill.scanLimitations.length}) -- <em>not security findings</em></summary>`,
        "",
        `_The scanner couldn't fully inspect some content below (e.g. a file exceeded its analysis size/bounds). This is a coverage gap, not evidence the skill does anything risky._`,
        "",
      );
      for (const r of skill.scanLimitations) {
        const occurrence = r.count > 1 ? ` (${r.count}x)` : "";
        lines.push(`- ${escapeMd(r.message)}${occurrence} — \`${r.rule}\``);
        for (const loc of r.locations) lines.push(`  - \`${loc}\``);
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
