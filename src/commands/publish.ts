import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import YAML from "yaml";
import { runScan } from "./scan.js";
import { HUB_URL, postJsonWithReauth } from "../session.js";

// Marker left in a published skill's own directory so `skillfn update` (and a friendly
// hint from `publish` itself) can find its skid without the user having to remember or
// re-type it -- same idea as a `.git` directory anchoring a repo to its remote.
export const SKID_MARKER_FILENAME = ".skillfn-skid";

export async function readSkidMarker(path: string): Promise<string | undefined> {
  try {
    return (await readFile(join(path, SKID_MARKER_FILENAME), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeSkidMarker(path: string, skid: string): Promise<void> {
  await writeFile(join(path, SKID_MARKER_FILENAME), skid + "\n", "utf8");
}

const COMMON_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "GPL-3.0-only",
  "CC0-1.0",
  "All rights reserved",
  "Custom",
];

export async function collectFiles(dir: string, base: string = dir): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: { path: string; content: string }[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === SKID_MARKER_FILENAME) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, base)));
    } else {
      try {
        const content = await readFile(full, "utf8");
        files.push({ path: relative(base, full), content });
      } catch {
        continue; // binary/unreadable -- skip, matches the scanner's own behavior
      }
    }
  }
  return files;
}

async function promptLicense(): Promise<{ licenseSpdxId?: string; licenseText?: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nChoose a license:");
    COMMON_LICENSES.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
    const answer = (await rl.question(`Enter a number [1-${COMMON_LICENSES.length}]: `)).trim();
    const index = Number(answer) - 1;
    const choice = COMMON_LICENSES[index];

    if (!choice) {
      console.log("Invalid choice.");
      process.exitCode = 1;
      return {};
    }
    if (choice === "Custom") {
      const text = await rl.question("Enter your custom license text: ");
      return { licenseText: text.trim() };
    }
    if (choice === "All rights reserved") {
      return { licenseText: "All rights reserved." };
    }
    return { licenseSpdxId: choice };
  } finally {
    rl.close();
  }
}

interface OriginalWorkDeclaration {
  isOriginalWork: boolean;
  sourceUrl?: string;
  originalAuthorHandle?: string;
}

/**
 * Required at publish time, independent of any indexing/crawler feature -- this is about
 * attribution for THIS publish, not "Google for Skills." Real gap found by a human retest
 * (2026-08-20): this was designed but never actually asked. See
 * extra/plans/11-indexing-and-claims.md's attribution section for why "verify every claim"
 * isn't achievable and this attestation + later dispute/report flow is the honest answer.
 */
async function promptOriginalWork(): Promise<OriginalWorkDeclaration> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("\nIs this entirely your own original work? [Y/n]: ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      return { isOriginalWork: true };
    }
    const sourceUrl = (await rl.question("Source URL for the original work (required): ")).trim();
    const originalAuthorHandle = (await rl.question("Original author, if known (optional): ")).trim();
    return { isOriginalWork: false, sourceUrl, originalAuthorHandle: originalAuthorHandle || undefined };
  } finally {
    rl.close();
  }
}

interface PublishOptions {
  license?: string;
  originalSource?: string;
  originalAuthor?: string;
  yes?: boolean;
}

export async function publishCommand(path: string, options: PublishOptions): Promise<void> {
  const existingSkid = await readSkidMarker(path);
  if (existingSkid) {
    console.log(
      `\nNote: this directory is already published as ${existingSkid}. ` +
        `Did you mean 'skillfn update ${path}'? Continuing will attempt to publish new, unrelated content.`,
    );
  }

  const scanResult = await runScan(path, { context: "publish", autoYes: options.yes });
  if (!scanResult.passed) {
    console.log("\nPublish aborted: the security scan did not pass. Run 'skillfn scan' for details.");
    process.exitCode = 1;
    return;
  }

  const skillMdPath = join(path, "SKILL.md");
  let name = "";
  let description = "";
  try {
    const text = await readFile(skillMdPath, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const front = YAML.parse(match[1]) as Record<string, unknown>;
      name = String(front.name ?? "");
      description = String(front.description ?? "");
    }
  } catch {
    // handled below
  }
  if (!name || !description) {
    console.log("\nPublish aborted: SKILL.md must have `name` and `description` in its frontmatter.");
    process.exitCode = 1;
    return;
  }

  let license: { licenseSpdxId?: string; licenseText?: string };
  if (options.license) {
    license = COMMON_LICENSES.includes(options.license)
      ? { licenseSpdxId: options.license }
      : { licenseText: options.license };
  } else {
    license = await promptLicense();
    if (!license.licenseSpdxId && !license.licenseText) return; // invalid choice already reported
  }

  const originalWork: OriginalWorkDeclaration = options.originalSource
    ? { isOriginalWork: false, sourceUrl: options.originalSource, originalAuthorHandle: options.originalAuthor }
    : await promptOriginalWork();

  const files = await collectFiles(path);

  console.log("\nPublishing…");
  const response = await postJsonWithReauth(`${HUB_URL}/api/publish`, {
    name,
    description,
    ...license,
    files,
    // Sent so the hub can store/display the REAL local scan (e.g. SkillSpector's
    // richer findings) instead of only its own weaker server-side re-check -- an
    // earlier version silently discarded this, so the hub showed "passed" with zero
    // visible findings even when the local scan found real, severity-rated issues.
    clientScan: scanResult,
    originalWork,
  });

  type FindingLike = { severity?: string; rule?: string; message?: string; file?: string };
  const result = (await response.json()) as {
    error?: string;
    clientFindings?: FindingLike[];
    serverFindings?: FindingLike[];
    skid?: string;
    url?: string;
  };
  if (!response.ok) {
    console.log(`\nPublish failed: ${result.error ?? response.statusText}`);
    const printFindings = (label: string, findings?: FindingLike[]) => {
      if (!Array.isArray(findings) || findings.length === 0) return;
      console.log(`  ${label}:`);
      for (const f of findings) {
        console.log(`    [${f.severity?.toUpperCase()}] ${f.rule} (${f.file}) — ${f.message}`);
      }
    };
    printFindings("Local scan findings", result.clientFindings);
    printFindings("Hub re-check findings", result.serverFindings);
    process.exitCode = 1;
    return;
  }

  if (result.skid) {
    await writeSkidMarker(path, result.skid);
  }
  console.log(`\nPublished: ${result.skid}`);
  console.log(`View it at: ${result.url}\n`);
  console.log(`(Tracked for future updates -- run 'skillfn update ${path}' after changing this skill.)`);
}
