import { writeFile } from "node:fs/promises";
import chalk from "chalk";
import type { Severity } from "./scanner/types.js";
import type { AggregateReport, AggregatedSkill, UniqueRisk } from "./aggregateScan.js";
import type { BrokenReason, BrokenReference, ReferenceKind } from "./brokenReferences.js";
import { heading, dim, warn, note, colorSeverity } from "./ui.js";
import { BASELINE_FILENAME } from "./suppression.js";

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

// Display-layer cap only, like MAX_LOCATIONS_DISPLAYED -- skill.referenceCheck.broken and
// the Markdown report always carry every entry.
const MAX_REFERENCES_PER_GROUP = 5;

const REASON_ORDER: BrokenReason[] = ["missing", "wrong-kind", "case-mismatch", "escapes-skill", "url-not-found", "url-unreachable"];
const REASON_LABEL: Record<BrokenReason, string> = {
  missing: "doesn't exist",
  "wrong-kind": "wrong kind -- file vs directory",
  "case-mismatch": "case mismatch -- breaks on case-sensitive filesystems",
  "escapes-skill": "points outside the skill folder",
  "url-not-found": "URL not found",
  "url-unreachable": "URL couldn't be reached -- may be transient, or you may be offline",
};
const KIND_LABEL: Record<ReferenceKind, string> = {
  "markdown-link": "markdown link",
  "markdown-image": "markdown image",
  "markdown-definition": "markdown link definition",
  autolink: "autolink",
  "inline-code": "inline code",
  "prose-path": "prose mention",
  "code-block-path": "code block",
  "command-script": "script in command",
};

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
  const reason =
    skill.incompleteReasons.length > 0
      ? skill.incompleteReasons.map((r) => r.replace(/\.+$/, "")).join("; ")
      : "some content wasn't inspected, for an unknown reason";
  const seeBelow = skill.scanLimitations.length > 0 ? ` See "scan limitations" below.` : "";
  // skillfn already auto-retries a genuine time/size truncation with up to 3600s (see
  // skillSpectorScanner.ts's hitWorkflowDeadline/MAX_AUTO_ESCALATED_WORKFLOW_SECONDS) before
  // this ever reaches the report -- seeing this means that already wasn't enough.
  const suggestion = skill.scanLimitations.length > 0
    ? " skillfn already retried with more time (up to 3600s) -- try an even higher SKILLSPECTOR_MAX_WORKFLOW_SECONDS yourself if this is an especially large skill."
    : skill.incompleteReasons.length === 0
      ? " Try 'skillfn scan' again -- this can be transient."
      : "";
  // Note: this is a scanner-side limitation, not a security verdict about the skill -- it
  // never affects the risk score or pass/fail result above.
  return `Analysis didn't fully complete${pct} -- ${reason}.${seeBelow}${suggestion}`;
}

function groupBrokenReferences(refs: BrokenReference[]): Array<[BrokenReason, BrokenReference[]]> {
  return REASON_ORDER.map((reason): [BrokenReason, BrokenReference[]] => [reason, refs.filter((r) => r.reason === reason)]).filter(
    ([, group]) => group.length > 0,
  );
}

/** Where a reference lives; the instance directory is only worth showing when the skill
 * exists in more than one place (otherwise it's the same path on every line). */
function referenceLocation(skill: AggregatedSkill, ref: BrokenReference): string {
  const where = `${ref.file}:${ref.line}`;
  return skill.instances.length > 1 ? `${ref.instance}/${where}` : where;
}

function referenceKindLabel(ref: BrokenReference): string {
  return `${KIND_LABEL[ref.kind]}${ref.heuristic ? ", heuristic" : ""}`;
}

function formatReferenceTree(skill: AggregatedSkill, full: boolean, prefix: string): string[] {
  const lines: string[] = [];
  const groups = groupBrokenReferences(skill.referenceCheck?.broken ?? []);
  groups.forEach(([reason, refs], gi) => {
    const groupIsLast = gi === groups.length - 1;
    lines.push(treeLine(prefix, groupIsLast, dim(`${REASON_LABEL[reason]} (${refs.length})`)));
    const groupPrefix = childPrefix(prefix, groupIsLast);
    const shown = full ? refs : refs.slice(0, MAX_REFERENCES_PER_GROUP);
    const hidden = refs.length - shown.length;

    shown.forEach((ref, ri) => {
      const isLast = ri === shown.length - 1 && hidden === 0;
      lines.push(treeLine(groupPrefix, isLast, `${ref.target} ${dim(`— ${referenceLocation(skill, ref)} (${referenceKindLabel(ref)})`)}`));
      if (ref.detail) lines.push(treeLine(childPrefix(groupPrefix, isLast), true, dim(ref.detail)));
    });
    if (hidden > 0) lines.push(treeLine(groupPrefix, true, dim(`+${hidden} more -- rerun with --full to see them`)));
  });
  return lines;
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
    lines.push(note(incompleteSummary(skill)));
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

  if (skill.suppressedCount > 0) {
    // Same reasoning as scan limitations: a reviewed baseline already excluded these from
    // every count above -- shown as a count only (not expanded) so a suppressed finding
    // doesn't just silently vanish with no trace that it ever existed, but also doesn't
    // clutter the report with findings someone already reviewed and accepted.
    topLevel.push({
      text: dim(`${skill.suppressedCount} suppressed finding(s) -- reviewed and accepted, see ${BASELINE_FILENAME}`),
    });
  }

  const refCheck = skill.referenceCheck;
  if (refCheck && refCheck.broken.length > 0) {
    // Same demotion as scan limitations above: hygiene, not risk, so it's dim, labeled as
    // informational, and kept out of "risk breakdown" and every severity count.
    topLevel.push({
      text: dim(`broken references (${refCheck.broken.length} -- informational, not security findings)`),
      children: (prefix) => formatReferenceTree(skill, options.full ?? false, prefix),
    });
  } else if (refCheck) {
    topLevel.push({ text: dim(`references: ${refCheck.referencesChecked} checked, none broken`) });
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
  const checked = report.skills.filter((s) => s.referenceCheck);
  if (checked.length > 0) {
    const brokenTotal = checked.reduce((n, s) => n + s.referenceCheck!.broken.length, 0);
    items.push(dim(`broken references: ${brokenTotal} across ${checked.length} skill(s) checked (informational, not counted above)`));
  }
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
  );
  const checkedSkills = report.skills.filter((s) => s.referenceCheck);
  if (checkedSkills.length > 0) {
    const brokenTotal = checkedSkills.reduce((n, s) => n + s.referenceCheck!.broken.length, 0);
    lines[lines.length - 1] += "  ";
    lines.push(`**Broken references:** ${brokenTotal} across ${checkedSkills.length} skill(s) checked (informational, not counted in the breakdown above)`);
  }
  lines.push("", "---", "");

  for (const skill of report.skills) {
    lines.push(`## ${escapeMd(skill.name)}`, "");
    if (skill.incomplete) {
      lines.push(`> ℹ️ ${escapeMd(incompleteSummary(skill))}`, "");
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

    if (skill.suppressedCount > 0) {
      lines.push(
        `**Suppressed:** ${skill.suppressedCount} finding(s) reviewed and accepted -- see \`${BASELINE_FILENAME}\` in the skill's own directory.`,
        "",
      );
    }

    const refCheck = skill.referenceCheck;
    if (refCheck) {
      const ran = [refCheck.options.links && "local links", refCheck.options.prose && "prose & code-block paths (heuristic)", refCheck.options.urls && "external URLs"]
        .filter(Boolean)
        .join(", ");
      const summary = `Checked ${refCheck.referencesChecked} reference(s) in ${refCheck.filesChecked} markdown file(s): ${ran}.`;
      if (refCheck.broken.length === 0) {
        lines.push(`**Reference check:** ${summary} None broken.`, "");
      } else {
        lines.push(
          `<details>`,
          `<summary>Broken references (${refCheck.broken.length}) -- <em>not security findings</em></summary>`,
          "",
          `_${summary} A dangling reference is a documentation/packaging problem, not evidence the skill does anything risky; it never affects the risk breakdown or pass/fail._`,
          "",
        );
        for (const [reason, refs] of groupBrokenReferences(refCheck.broken)) {
          lines.push(`**${escapeMd(REASON_LABEL[reason])}** (${refs.length})`, "");
          for (const ref of refs) {
            lines.push(`- \`${ref.target}\` — \`${ref.instance}/${ref.file}:${ref.line}\` (${referenceKindLabel(ref)})`);
            if (ref.detail) lines.push(`  - ${escapeMd(ref.detail)}`);
          }
          lines.push("");
        }
        lines.push(`</details>`, "");
      }
    }

    lines.push("---", "");
  }

  return lines.join("\n");
}

export async function writeMarkdownReport(report: AggregateReport, path: string): Promise<void> {
  await writeFile(path, buildMarkdownReport(report), "utf8");
}
