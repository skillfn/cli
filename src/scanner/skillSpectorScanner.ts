import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Finding,
  type Scanner,
  type ScanResult,
  type Severity,
  computeRiskScore,
  decidePass,
} from "./types.js";

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
  return {
    rule: String(firstDefined(raw, RULE_KEYS) ?? "skillspector-finding"),
    severity: normalizeSeverity(firstDefined(raw, SEVERITY_KEYS)),
    message,
    remediation: raw.remediation !== undefined && raw.remediation !== null ? String(raw.remediation) : undefined,
    file,
    line,
    taxonomy: firstDefined(raw, CATEGORY_KEYS) as string | undefined,
  };
}

/** Distinguishes "binary not on PATH" from any other spawn/exit outcome — see the exit-code note below. */
class ScannerNotInstalledError extends Error {}

function runSkillSpector(skillDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "skillspector",
      ["scan", skillDir, "--no-llm", "--format", "json", "--output", outputPath],
      { stdio: ["ignore", "pipe", "pipe"] },
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
    const workDir = await mkdtemp(join(tmpdir(), "skillfn-scan-"));
    const outputPath = join(workDir, "report.json");

    // Not a blanket try/finally: the "unrecognized schema" branch below deliberately
    // keeps workDir on disk so the raw report it points to is actually inspectable —
    // deleting it there would make that error message a lie.
    await runSkillSpector(skillDir, outputPath);

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
      return {
        scannerName: skillSpectorScanner.name,
        passed: severity !== "high" && severity !== "critical",
        riskScore: ra.score as number,
        findings,
      };
    }

    return {
      scannerName: skillSpectorScanner.name,
      passed: decidePass(findings),
      riskScore: computeRiskScore(findings),
      findings,
    };
  },
};

export { ScannerNotInstalledError };
