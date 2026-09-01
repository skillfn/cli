import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import YAML from "yaml";
import {
  type Finding,
  type Scanner,
  type ScanResult,
  computeRiskScore,
  decidePass,
} from "./types.js";

/**
 * Deterministic, local, no-network rule-based scanner.
 *
 * This exists because we deliberately do NOT build a from-scratch competing detection
 * engine (extra/plans/00-MASTERPLAN.md, settled fact #4 — NVIDIA/Cisco/Snyk already
 * invest heavily here). This ruleset is intentionally small and mirrors the minimal-v1
 * consensus found across the security literature reviewed for this project (typosquat/
 * name checks, dangerous script patterns, unpinned remote fetches, credential/exfiltration
 * heuristics, and description-vs-behavior mismatches). It is meant to be replaced/joined
 * by real third-party engines (Cisco's `skill-scanner`, first) behind the `Scanner`
 * interface once that integration is verified — see extra/plans/03-security-gate.md.
 */

const DANGEROUS_SHELL_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /rm\s+-rf\s+\/(?!\S)/i, message: "Recursive delete of root filesystem." },
  { re: /curl[^\n]*\|\s*(sh|bash)\b/i, message: "Pipes a remote download directly into a shell." },
  { re: /wget[^\n]*\|\s*(sh|bash)\b/i, message: "Pipes a remote download directly into a shell." },
  { re: /\beval\s*\(/i, message: "Uses eval() on dynamic input." },
  { re: /\bexec\s*\(/i, message: "Uses exec() on dynamic input." },
  { re: /child_process\.exec\s*\(/i, message: "Shells out via child_process.exec." },
  { re: /subprocess\.(Popen|call|run)\s*\([^)]*shell\s*=\s*True/i, message: "Runs a subprocess with shell=True." },
  { re: /os\.system\s*\(/i, message: "Uses os.system() to run a shell command." },
];

// Reading an actual credential FILE (~/.ssh, .aws/credentials) and then making a network
// call is genuinely suspicious. Reading process.env/os.environ is NOT -- that's the single
// most common pattern in all API-client code (read your own key, call the API it's for).
// Confirmed by testing against 19 real Anthropic official skills (2026-09-01): the old
// combined list flagged claude-api's and mcp-builder's own API-integration docs as
// "CRITICAL possible credential exfiltration" for exactly this benign pattern -- a false
// positive rate too high to ship, especially since this fallback scanner is what a brand
// new user hits before installing SkillSpector.
const SENSITIVE_CREDENTIAL_FILE_PATTERNS = [/~\/\.ssh/i, /\.aws\/credentials/i, /\.npmrc\b/i];

const GENERIC_ENV_ACCESS_PATTERNS = [/\.env\b/i, /process\.env\s*\[/i, /os\.environ/i];

const NETWORK_CALL_PATTERNS = [
  /fetch\s*\(/i,
  /axios\.(post|get)\s*\(/i,
  /requests\.(post|get)\s*\(/i,
  /curl\s+https?:\/\//i,
  /http\.request\s*\(/i,
];

const NEGATION_CUE_NEAR = /\b(avoid|don'?t|never|instead of|such as|for example|e\.g\.|like ["'])\b/i;

const PROMPT_INJECTION_PHRASES = [
  /ignore (all|any|the) (previous|prior|above) instructions/i,
  /disregard (all|any|the) (previous|prior|above)/i,
  /ignore (the )?system prompt/i,
  /you are now (in )?developer mode/i,
];

// Zero-width / bidi-control characters used for concealment (a real, documented technique).
// Written as explicit escapes rather than literal characters — literal invisible characters
// in source code cannot be visually verified and are themselves a concealment risk.
const CONCEALMENT_CHARS = /[\u200B\u200C\u200D\uFEFF\u202A-\u202E\u2060-\u2064]/;

const NON_HTTPS_REMOTE_FETCH = /\b(curl|wget)\s+http:\/\//i;

const CAPABILITY_KEYWORDS = ["fetch", "download", "network", "execute", "run a script", "install"];

async function walk(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, base)));
    } else {
      files.push(relative(base, full));
    }
  }
  return files;
}

function scanTextForRules(
  text: string,
  file: string,
): Finding[] {
  const findings: Finding[] = [];

  for (const { re, message } of DANGEROUS_SHELL_PATTERNS) {
    if (re.test(text)) {
      findings.push({
        rule: "dangerous-shell-pattern",
        severity: "high",
        message,
        file,
      });
    }
  }

  const hasSensitiveCredentialFile = SENSITIVE_CREDENTIAL_FILE_PATTERNS.some((re) => re.test(text));
  const hasGenericEnvAccess = GENERIC_ENV_ACCESS_PATTERNS.some((re) => re.test(text));
  const hasNetworkCall = NETWORK_CALL_PATTERNS.some((re) => re.test(text));
  if (hasSensitiveCredentialFile && hasNetworkCall) {
    findings.push({
      rule: "possible-credential-exfiltration",
      severity: "critical",
      message:
        "File reads an actual credential file (SSH key, AWS credentials, npm token) and also makes a network call — verify this isn't exfiltrating secrets.",
      file,
    });
  } else if (hasGenericEnvAccess && hasNetworkCall) {
    // Low, not critical -- reading an env var and calling an API is the normal shape of
    // API-client code, not a red flag on its own. Still surfaced as a note, not silently
    // dropped, since it's the one condition under which a REAL exfiltration would also
    // show up this way.
    findings.push({
      rule: "env-and-network-co-occurrence",
      severity: "low",
      message: "Reads environment variables and makes a network call — normal for API-client code, worth a quick look if unfamiliar.",
      file,
    });
  }

  if (NON_HTTPS_REMOTE_FETCH.test(text)) {
    findings.push({
      rule: "unpinned-insecure-remote-fetch",
      severity: "medium",
      message: "Fetches a remote resource over plain HTTP with no integrity check.",
      file,
    });
  }

  for (const re of PROMPT_INJECTION_PHRASES) {
    const match = re.exec(text);
    // A short window of preceding text is checked for an explicit negation/counter-example
    // cue ("avoid", "don't", "e.g.") -- confirmed real case (2026-09-01): Anthropic's own
    // claude-api skill documents *avoiding* override-style language, quoting the exact
    // phrase as a negative example, which isn't an attempted injection. This is a bounded,
    // cheap heuristic, not an attempt to add real NLP to a deliberately minimal fallback
    // scanner (see this file's header) -- it only suppresses the single most common
    // false-positive shape actually observed, not a general context-understanding claim.
    if (match && !NEGATION_CUE_NEAR.test(text.slice(Math.max(0, match.index - 200), match.index))) {
      findings.push({
        rule: "prompt-injection-marker",
        severity: "high",
        message: "Contains a phrase commonly used to override an agent's prior instructions.",
        file,
      });
    }
  }

  // A leading BOM (U+FEFF at offset 0) is a completely standard file-encoding marker, not
  // concealment -- confirmed by testing against real files (2026-09-01): Anthropic's own
  // docx/pptx/xlsx skills vendor OOXML .xsd schema files that all start with one, and it
  // was wrongly flagging every one of them. A BOM (or any of these chars) appearing
  // mid-file is still exactly the concealment technique this rule exists to catch.
  const concealmentText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (CONCEALMENT_CHARS.test(concealmentText)) {
    findings.push({
      rule: "concealment-characters",
      severity: "high",
      message: "Contains zero-width or bidi-control characters, a known technique for hiding instructions from human review.",
      file,
    });
  }

  return findings;
}

async function scanSkillMdFrontmatterMismatch(
  skillMdPath: string,
  text: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    findings.push({
      rule: "missing-frontmatter",
      severity: "medium",
      message: "SKILL.md has no YAML frontmatter block (expected `name` and `description`).",
      file: skillMdPath,
    });
    return findings;
  }

  let description = "";
  try {
    const front = YAML.parse(match[1]) as Record<string, unknown>;
    description = String(front.description ?? "");
    if (!front.name || !front.description) {
      findings.push({
        rule: "incomplete-frontmatter",
        severity: "medium",
        message: "Frontmatter is missing `name` and/or `description`.",
        file: skillMdPath,
      });
    }
  } catch {
    findings.push({
      rule: "invalid-frontmatter",
      severity: "medium",
      message: "Frontmatter block could not be parsed as YAML.",
      file: skillMdPath,
    });
    return findings;
  }

  const body = text.slice(match[0].length);
  const bodyMentionsCapability = CAPABILITY_KEYWORDS.some((kw) =>
    body.toLowerCase().includes(kw),
  );
  const descriptionMentionsCapability = CAPABILITY_KEYWORDS.some((kw) =>
    description.toLowerCase().includes(kw),
  );

  if (bodyMentionsCapability && !descriptionMentionsCapability) {
    findings.push({
      rule: "undisclosed-capability",
      severity: "low",
      message:
        "Instructions reference network/execution capabilities that the one-line description doesn't disclose.",
      file: skillMdPath,
    });
  }

  return findings;
}

export const patternScanner: Scanner = {
  name: "pattern-scanner-v1",

  async scan(skillDir: string): Promise<ScanResult> {
    const files = await walk(skillDir, skillDir);
    const findings: Finding[] = [];

    for (const file of files) {
      const full = join(skillDir, file);
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue; // binary or unreadable file — skip rather than fail the whole scan
      }

      findings.push(...scanTextForRules(text, file));

      if (file.toLowerCase() === "skill.md") {
        findings.push(...(await scanSkillMdFrontmatterMismatch(file, text)));
      }
    }

    return {
      scannerName: patternScanner.name,
      passed: decidePass(findings),
      riskScore: computeRiskScore(findings),
      findings,
    };
  },
};
