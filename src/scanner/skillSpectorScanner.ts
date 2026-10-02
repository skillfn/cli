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
/**
 * SkillSpector's `analysis_completeness.limitations` (a plain string array) is NOT the only
 * place it explains an incomplete result -- `ledger_exceptions` (confirmed real field,
 * `outcome`/`phase`/`reason_code`/`message` per entry) is a separate, more detailed account
 * of specific things it couldn't fully resolve, e.g. a `reference_resolution` exception for
 * "a local path-like reference does not match any bundled artifact." Confirmed real case: a
 * scan with every analyzer reporting "completed" and 100% file coverage still came back
 * `is_complete: false` with an EMPTY `limitations` array -- looked unexplained and possibly
 * flaky, until the raw report showed a non-empty `ledger_exceptions` entry that `limitations`
 * alone never surfaced. Read both, so a real, already-present explanation isn't missed.
 */
function extractLedgerExceptionReasons(raw: Record<string, unknown>): string[] {
  const exceptions = raw.ledger_exceptions;
  if (!Array.isArray(exceptions)) return [];
  return exceptions
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : undefined))
    .filter((e): e is Record<string, unknown> => e !== undefined)
    .map((e) => (typeof e.message === "string" ? e.message : undefined))
    .filter((m): m is string => m !== undefined);
}

function extractCompleteness(raw: unknown): AnalysisCompleteness | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.is_complete !== "boolean") return undefined;
  const limitations = Array.isArray(c.limitations) ? c.limitations.filter((l): l is string => typeof l === "string") : [];
  return {
    isComplete: c.is_complete,
    status: typeof c.status === "string" ? c.status : c.is_complete ? "complete" : "partial",
    coveragePercent: typeof c.coverage_percent === "number" ? c.coverage_percent : 0,
    fullyInspectedFiles: typeof c.fully_inspected_files === "number" ? c.fully_inspected_files : 0,
    partiallyInspectedFiles: typeof c.partially_inspected_files === "number" ? c.partially_inspected_files : 0,
    entirelyUninspectedFiles: typeof c.entirely_uninspected_files === "number" ? c.entirely_uninspected_files : 0,
    limitations: [...new Set([...limitations, ...extractLedgerExceptionReasons(c)])],
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
const DEFAULT_WORKFLOW_SECONDS = 1800;

/**
 * Hard ceiling for skillfn's own AUTOMATIC escalation -- never exceeded regardless of how
 * large a skill is, even if a first attempt still truncates at this value. SkillSpector's own
 * workflow deadline is a deliberate DoS/safety boundary (its docs call out adversarial bundles
 * at scale -- zip bombs, oversized files), so open-ended automatic escalation would quietly
 * defeat that protection on an adversarial skill. A user who deliberately sets their own
 * SKILLSPECTOR_MAX_WORKFLOW_SECONDS above this is respected as-is (see escalatedSeconds) --
 * this ceiling only bounds what skillfn decides to do on its own, not what someone explicitly
 * asked for.
 */
const MAX_AUTO_ESCALATED_WORKFLOW_SECONDS = 3600;

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

function runSkillSpector(skillDir: string, outputPath: string, baselinePath: string | undefined, workflowSeconds: number): Promise<void> {
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
          SKILLSPECTOR_MAX_WORKFLOW_SECONDS: String(workflowSeconds),
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

/**
 * True when SkillSpector reported it couldn't fully complete, but gave literally no reason
 * (empty `limitations`) -- as opposed to a specific, explained cause like "Analyzer X status:
 * degraded." or a real AE1 content-size truncation. Confirmed real case: an identical,
 * 12-file skill came back `isComplete: false` with zero explanation, consistently across
 * repeated runs, on a scan that otherwise finished in seconds -- a transient hiccup is a far
 * more likely explanation than the scanner having an actual, inherent problem with that
 * content, and a cheap retry is the standard way serious systems handle exactly this shape of
 * signal (an unexplained transient failure) rather than surfacing it to the end user
 * immediately. An explained incompleteness is never retried: the explanation is real
 * information (e.g. a genuine size/time limit) that retrying the same content won't change.
 */
function isUnexplainedIncomplete(completeness: AnalysisCompleteness | undefined): boolean {
  return completeness !== undefined && !completeness.isComplete && completeness.limitations.length === 0;
}

async function runOnce(skillDir: string, vendoredDirs: string[], baselinePath: string | undefined, workflowSeconds: number): Promise<ScanResult> {
  const { stagedDir, cleanup: cleanupStage } = await stageFilteredSkillDir(skillDir, vendoredDirs);
  try {
    const workDir = await mkdtemp(join(tmpdir(), "skillfn-scan-"));
    const outputPath = join(workDir, "report.json");

    // workDir itself is deliberately NOT covered by the outer try/finally (that only cleans
    // the staged skill copy): the "unrecognized schema" branch below keeps workDir on disk so
    // the raw report it points to is actually inspectable -- deleting it there would make
    // that error message a lie.
    await runSkillSpector(stagedDir, outputPath, baselinePath, workflowSeconds);

    let raw: string;
    try {
      raw = await readFile(outputPath, "utf8");
    } catch {
      await rm(workDir, { recursive: true, force: true });
      throw new Error(
        "SkillSpector ran but produced no output file — check its version supports --format json --output.",
      );
    }

    const parsed = JSON.parse(raw) as unknown;
    const findingsArray = findFindingsArray(parsed);

    if (findingsArray === undefined) {
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
  } finally {
    await cleanupStage();
  }
}

/** Same (rule, file, line) occurrence reported by both attempts counts once, not twice. */
function findingKey(f: Finding): string {
  return `${f.rule}::${f.file}::${f.line ?? ""}`;
}

/**
 * Merges a retry's result into the first attempt's WITHOUT discarding anything the first
 * attempt found -- a retry on a security scanner must only ever be able to ADD information
 * (a finding either attempt surfaced), never silently drop one attempt's findings in favor of
 * the other's. Determinism held in every case tested while building this (identical finding
 * sets across 5 repeated runs, including ones that reproduced the unexplained-incomplete
 * state itself), but "held in every case I happened to test" is not a guarantee, and the cost
 * of being wrong here is a missed real finding -- the one outcome this tool exists to avoid.
 * Recomputes passed/riskScore from the union via skillfn's own decidePass/computeRiskScore
 * rather than trusting either attempt's own risk_assessment figure, since that number was
 * computed by SkillSpector for its own single attempt's finding set, not this union.
 */
function unionResults(first: ScanResult, retried: ScanResult): ScanResult {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const f of [...first.findings, ...retried.findings]) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }

  const stillUnexplained = isUnexplainedIncomplete(retried.completeness);
  const completeness =
    stillUnexplained && retried.completeness
      ? {
          ...retried.completeness,
          limitations: ["SkillSpector reported incomplete analysis without explaining why, on two separate attempts"],
        }
      : retried.completeness;

  return {
    scannerName: skillSpectorScanner.name,
    passed: decidePass(findings),
    riskScore: computeRiskScore(findings),
    findings,
    completeness,
    suppressedCount: Math.max(first.suppressedCount ?? 0, retried.suppressedCount ?? 0),
  };
}

/** AE1 ("referenced artifact was not completely inspected") only ever arises from genuine
 * content/size truncation hitting SkillSpector's own workflow deadline -- the reliable signal
 * that more time, not a retry at the same deadline, is the thing that might actually help. */
function hitWorkflowDeadline(result: ScanResult): boolean {
  return result.findings.some((f) => f.isCoverageLimitation);
}

export const skillSpectorScanner: Scanner = {
  name: "nvidia-skillspector",

  async scan(skillDir: string): Promise<ScanResult> {
    const { boundaries } = await findVendoredSubtreesUnder(skillDir);
    const vendoredDirs = boundaries.map((b) => b.dir);
    // A baseline is always read from the skill's OWN directory, never the staged copy --
    // same file either way, but this keeps the lookup obvious and independent of staging.
    const baselinePath = (await baselineExists(skillDir)) ? baselinePathFor(skillDir) : undefined;

    // An explicit user override is always respected as the starting point -- never silently
    // raised past what someone deliberately set, only ever used as-is.
    const configuredSeconds = process.env.SKILLSPECTOR_MAX_WORKFLOW_SECONDS
      ? Number(process.env.SKILLSPECTOR_MAX_WORKFLOW_SECONDS)
      : DEFAULT_WORKFLOW_SECONDS;

    const first = await runOnce(skillDir, vendoredDirs, baselinePath, configuredSeconds);
    const unexplained = isUnexplainedIncomplete(first.completeness);
    // Only escalate automatically up to the hard ceiling, and only if the first attempt
    // didn't already use at least that much -- an explicit higher value from the user is
    // respected, not silently doubled further (see MAX_AUTO_ESCALATED_WORKFLOW_SECONDS).
    const canEscalate = hitWorkflowDeadline(first) && configuredSeconds < MAX_AUTO_ESCALATED_WORKFLOW_SECONDS;
    if (!unexplained && !canEscalate) return first;

    // One transparent retry before the user ever sees a problem -- longer, bounded time for a
    // genuine size/time truncation (see hitWorkflowDeadline), or the same time again for an
    // unexplained incompleteness (see isUnexplainedIncomplete) where more time wouldn't be
    // expected to change anything but a one-off hiccup might resolve on its own. Findings from
    // both attempts are unioned (see unionResults), never replaced, so this can only ever
    // surface more than the first attempt found, never less.
    const retrySeconds = canEscalate ? Math.min(MAX_AUTO_ESCALATED_WORKFLOW_SECONDS, configuredSeconds * 2) : configuredSeconds;
    const retried = await runOnce(skillDir, vendoredDirs, baselinePath, retrySeconds);
    return unionResults(first, retried);
  },
};

export { ScannerNotInstalledError };
