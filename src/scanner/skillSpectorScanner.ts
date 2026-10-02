import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  type AnalysisCompleteness,
  type Finding,
  type Scanner,
  type ScanResult,
  type Severity,
  computeRiskScore,
  decidePass,
} from "./types.js";
import { EXCLUDED_DIR_NAMES } from "../skillExclusions.js";
import { findVendoredSubtreesUnder } from "../skillTreeDiscovery.js";
import { baselineExists, baselinePathFor } from "../suppression.js";

/**
 * Wraps NVIDIA SkillSpector (github.com/NVIDIA/SkillSpector, Apache 2.0) — the primary
 * v1 security gate, chosen for verified-firsthand Claude Code support, a real offline
 * mode, and a 69-pattern/17-category ruleset, over Cisco's skill-scanner (an earlier,
 * corrected guess) or Snyk's agent-scan (requires an account/token, disqualified).
 *
 * Requires `skillspector` on PATH: `uv tool install git+https://github.com/NVIDIA/skillspector.git`.
 * Runs with --no-llm so it never needs an API key and never phones out for LLM-assisted analysis.
 *
 * SCHEMA CONFIRMED (2026-08-20) against a real `skillspector==2.9.6` run — not a guess anymore.
 * Real shape:
 *   { skill: {...}, risk_assessment: { score: number, severity: "LOW"|"MEDIUM"|"HIGH"|..., recommendation },
 *     components: [...], issues: [ { id, finding_id, category, severity, confidence,
 *     location: { file, start_line, end_line }, explanation, remediation, code_snippet, tags }, ... ],
 *     suppressed_count, suppressed, metadata, execution_successful, analysis_completeness }
 * Two real bugs existed in the original defensive-guess version of this file before that test run:
 * the message field is `explanation`, not `message`/`description` (so every finding showed the
 * generic fallback text), and `location` is a nested object `{file, start_line}`, not a flat
 * string (so `file` would have stringified to "[object Object]"). Both fixed below.
 *
 * The alias lists are kept (not hardcoded to only the confirmed field names) because this
 * scanner may see output from a different skillspector version someday — better to stay
 * tolerant of drift than brittle to it, now that the primary shape is a confirmed fact rather
 * than a guess.
 */

const FINDINGS_ARRAY_KEYS = ["issues", "findings", "results", "vulnerabilities", "detections"];
const SEVERITY_KEYS = ["severity", "risk", "level", "risk_level", "severity_level"];
const MESSAGE_KEYS = ["explanation", "message", "description", "title", "summary", "detail"];
const FILE_KEYS = ["file", "path", "filepath", "file_path"];
const LINE_KEYS = ["line", "start_line", "line_number", "lineno"];
const RULE_KEYS = ["id", "rule", "check", "pattern_id", "rule_id"];
const CATEGORY_KEYS = ["category", "taxonomy", "type"];

/**
 * Rule IDs confirmed (from a real scan, 2026-10) to report the scanner's OWN inability to
 * fully inspect something, not a claim about the skill's behavior -- "AE1: referenced
 * artifact was not completely inspected" showed up tagged HIGH severity and would otherwise
 * have single-handedly failed the gate and inflated the severity breakdown purely because a
 * file exceeded SkillSpector's analysis size/bounds limit, with zero evidence of anything
 * malicious. Only AE1 is confirmed; add more here only once actually observed, not guessed.
 */
const COVERAGE_LIMITATION_RULE_IDS = new Set(["AE1"]);

function firstDefined(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function normalizeSeverity(raw: unknown): Severity {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("crit")) return "critical";
  if (s.includes("high")) return "high";
  if (s.includes("med")) return "medium";
  if (s.includes("low")) return "low";
  return "medium"; // unknown severity — err toward caution rather than "info"
}

function findFindingsArray(json: unknown): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  if (typeof json !== "object" || json === null) return undefined;
  const obj = json as Record<string, unknown>;
  for (const key of FINDINGS_ARRAY_KEYS) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  }
  return undefined;
}

/**
 * Confirmed real shape nests file/line under `location: { file, start_line, end_line }`,
 * not as flat top-level fields — this is handled first and explicitly, with the flat
 * FILE_KEYS/LINE_KEYS alias lookup kept only as a fallback for other/future scanner shapes.
 */
function extractLocation(raw: Record<string, unknown>): { file: string; line?: number } {
  const location = raw.location;
  if (location && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    const file = loc.file ?? loc.path;
    if (file !== undefined) {
      const line = loc.start_line ?? loc.line ?? loc.line_number;
      return {
        file: String(file),
        line: line !== undefined && line !== null ? Number(line) : undefined,
      };
    }
  }
  const file = firstDefined(raw, FILE_KEYS);
  const lineRaw = firstDefined(raw, LINE_KEYS);
  return {
    file: String(file ?? "unknown"),
    line: lineRaw !== undefined ? Number(lineRaw) : undefined,
  };
}

function mapRawFinding(raw: Record<string, unknown>): Finding {
  const { file, line } = extractLocation(raw);
  const message = String(firstDefined(raw, MESSAGE_KEYS) ?? "SkillSpector finding (no message field recognized).");
  const rule = String(firstDefined(raw, RULE_KEYS) ?? "skillspector-finding");
  return {
    rule,
    severity: normalizeSeverity(firstDefined(raw, SEVERITY_KEYS)),
    message,
    remediation: raw.remediation !== undefined && raw.remediation !== null ? String(raw.remediation) : undefined,
    file,
    line,
    taxonomy: firstDefined(raw, CATEGORY_KEYS) as string | undefined,
    isCoverageLimitation: COVERAGE_LIMITATION_RULE_IDS.has(rule),
  };
}

/**
 * SkillSpector's own authoritative completeness signal (confirmed field, see
 * inspection_ledger.py's AnalysisCompleteness) -- an explicit "did the scan actually
 * finish," rather than leaving it to be inferred indirectly from AE1-style finding counts.
 * Tolerant of a missing/malformed field (older SkillSpector versions, or another scanner
 * behind the same interface someday): completeness is just omitted, not fabricated.
 */
function extractCompleteness(raw: unknown): AnalysisCompleteness | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.is_complete !== "boolean") return undefined;
  return {
    isComplete: c.is_complete,
    status: typeof c.status === "string" ? c.status : c.is_complete ? "complete" : "partial",
    coveragePercent: typeof c.coverage_percent === "number" ? c.coverage_percent : 0,
    fullyInspectedFiles: typeof c.fully_inspected_files === "number" ? c.fully_inspected_files : 0,
    partiallyInspectedFiles: typeof c.partially_inspected_files === "number" ? c.partially_inspected_files : 0,
    entirelyUninspectedFiles: typeof c.entirely_uninspected_files === "number" ? c.entirely_uninspected_files : 0,
    limitations: Array.isArray(c.limitations) ? c.limitations.filter((l): l is string => typeof l === "string") : [],
  };
}

/** Distinguishes "binary not on PATH" from any other spawn/exit outcome — see the exit-code note below. */
class ScannerNotInstalledError extends Error {}

/**
 * SkillSpector's own default aggregate-workflow deadline is 600s (confirmed from its source
 * and docs/ANALYSIS_RESOURCE_BOUNDS.md) -- a safety ceiling against adversarial bundles at
 * scale (zip bombs, oversized files), not a limit relevant to skillfn's actual use case: one
 * local, user-owned skill directory, scanned one at a time. Hitting that deadline mid-scan is
 * exactly what produces a flood of "AE1: referenced artifact was not completely inspected"
 * findings (confirmed real case: a 10m19s scan, just past the 600s/10min default, on a skill
 * with a large adapters/examples/references tree). Raised here via the documented
 * SKILLSPECTOR_MAX_WORKFLOW_SECONDS env var (read once at process start, so this must be set
 * before spawning, not after) rather than attempting to patch or route around SkillSpector's
 * own resource ceilings, which exist for real security reasons and aren't a bug to fix.
 * Overridable for anyone who still wants SkillSpector's own default or something longer.
 */
const DEFAULT_WORKFLOW_SECONDS = "1800";

/**
 * Copies `skillDir` into a scratch directory with VCS/dependency internals and any nested
 * vendored skill subtrees left out, and points SkillSpector at the copy instead of the real
 * directory -- SkillSpector walks whatever path it's given with no exclusions of its own, so
 * without this, scanning a skill that happens to contain a `.git` folder or a whole other
 * skill package nested inside it reports THAT content's findings as if they belonged to the
 * skill being scanned (confirmed real case: a vendored third-party repo's own stock git
 * hooks -- harmless boilerplate every `git init` creates -- showed up as 14 HIGH "executable
 * nested in a document" findings on an unrelated skill).
 *
 * Finding locations in SkillSpector's report are paths relative to the scanned directory, so
 * callers that already prefix locations with the real `skillDir` (see aggregateScan.ts)
 * don't need to know this staging happened -- the relative paths line up either way.
 */
async function stageFilteredSkillDir(skillDir: string, excludeDirs: string[]): Promise<{ stagedDir: string; cleanup: () => Promise<void> }> {
  const stageRoot = await mkdtemp(join(tmpdir(), "skillfn-stage-"));
  const stagedDir = join(stageRoot, "skill");
  await cp(skillDir, stagedDir, {
    recursive: true,
    filter: (source) => {
      if (EXCLUDED_DIR_NAMES.has(basename(source))) return false;
      return !excludeDirs.some((dir) => source === dir || source.startsWith(`${dir}${sep}`));
    },
  });
  return { stagedDir, cleanup: () => rm(stageRoot, { recursive: true, force: true }) };
}

function runSkillSpector(skillDir: string, outputPath: string, baselinePath: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["scan", skillDir, "--no-llm", "--format", "json", "--output", outputPath];
    // --show-suppressed always, when a baseline applies -- cheap (doesn't affect scoring),
    // and it's the only way skillfn can report "N reviewed finding(s) not shown" instead of
    // a suppressed finding just silently vanishing with no trace in the report at all.
    if (baselinePath) args.push("--baseline", baselinePath, "--show-suppressed");
    const child = spawn(
      "skillspector",
      args,
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SKILLSPECTOR_MAX_WORKFLOW_SECONDS: process.env.SKILLSPECTOR_MAX_WORKFLOW_SECONDS ?? DEFAULT_WORKFLOW_SECONDS,
        },
      },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ScannerNotInstalledError("skillspector binary not found on PATH"));
      } else {
        reject(err);
      }
    });

    // Confirmed (2026-08-20 test run): SkillSpector exits 0 even with MEDIUM-severity
    // findings present, so exit code isn't a reliable pass/fail signal either way — we
    // always parse the JSON report regardless of exit code.
    child.on("close", () => resolve());
    void stderr;
  });
}

export const skillSpectorScanner: Scanner = {
  name: "nvidia-skillspector",

  async scan(skillDir: string): Promise<ScanResult> {
    const { boundaries } = await findVendoredSubtreesUnder(skillDir);
    const { stagedDir, cleanup: cleanupStage } = await stageFilteredSkillDir(
      skillDir,
      boundaries.map((b) => b.dir),
    );

    // A baseline is always read from the skill's OWN directory, never the staged copy --
    // same file either way, but this keeps the lookup obvious and independent of staging.
    const baselinePath = (await baselineExists(skillDir)) ? baselinePathFor(skillDir) : undefined;

    const workDir = await mkdtemp(join(tmpdir(), "skillfn-scan-"));
    const outputPath = join(workDir, "report.json");

    // Not a blanket try/finally: the "unrecognized schema" branch below deliberately
    // keeps workDir on disk so the raw report it points to is actually inspectable —
    // deleting it there would make that error message a lie.
    await runSkillSpector(stagedDir, outputPath, baselinePath);

    let raw: string;
    try {
      raw = await readFile(outputPath, "utf8");
    } catch {
      await rm(workDir, { recursive: true, force: true });
      await cleanupStage();
      throw new Error(
        "SkillSpector ran but produced no output file — check its version supports --format json --output.",
      );
    }

    const parsed = JSON.parse(raw) as unknown;
    const findingsArray = findFindingsArray(parsed);

    if (findingsArray === undefined) {
      await cleanupStage();
      throw new Error(
        `SkillSpector output did not contain a recognizable findings array (looked for keys: ${FINDINGS_ARRAY_KEYS.join(", ")}). ` +
          `Raw report retained at ${outputPath} for inspection — refusing to report a false pass.`,
      );
    }

    const findings = findingsArray.map(mapRawFinding);
    const completeness = extractCompleteness((parsed as Record<string, unknown>).analysis_completeness);
    const suppressedCountRaw = (parsed as Record<string, unknown>).suppressed_count;
    const suppressedCount = typeof suppressedCountRaw === "number" ? suppressedCountRaw : undefined;
    await rm(workDir, { recursive: true, force: true });
    await cleanupStage();

    // Prefer SkillSpector's own authoritative risk_assessment (confirmed real field,
    // accounts for suppression rules etc.) over recomputing from raw findings. Only fall
    // back to our own computation if that field is missing or malformed — never silently
    // trust an unverifiable shape as if it were the confirmed one.
    const riskAssessment = (parsed as Record<string, unknown>).risk_assessment;
    if (
      riskAssessment &&
      typeof riskAssessment === "object" &&
      typeof (riskAssessment as Record<string, unknown>).severity === "string" &&
      typeof (riskAssessment as Record<string, unknown>).score === "number"
    ) {
      const ra = riskAssessment as Record<string, unknown>;
      const severity = normalizeSeverity(ra.severity);
      const reportedFailure = severity === "high" || severity === "critical";
      // SkillSpector's own aggregate severity can be driven entirely by coverage-limitation
      // findings (confirmed real case: 24 "AE1: referenced artifact was not completely
      // inspected" findings alone pushed its overall severity to HIGH, with zero genuine
      // high/critical findings underneath) -- we can't see how SkillSpector weighs its own
      // aggregate, but we CAN check whether any actual behavioral finding justifies failing.
      // Never let "the scanner couldn't fully look at this" fail the gate on its own.
      const hasGenuineHighOrCritical = findings.some(
        (f) => !f.isCoverageLimitation && (f.severity === "high" || f.severity === "critical"),
      );
      return {
        scannerName: skillSpectorScanner.name,
        passed: !reportedFailure || !hasGenuineHighOrCritical,
        riskScore: ra.score as number,
        findings,
        completeness,
        suppressedCount,
      };
    }

    return {
      scannerName: skillSpectorScanner.name,
      passed: decidePass(findings),
      riskScore: computeRiskScore(findings),
      findings,
      completeness,
      suppressedCount,
    };
  },
};

export { ScannerNotInstalledError };
