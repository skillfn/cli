import { runScan, SkillSpectorRequiredError } from "./scan.js";
import { HUB_URL, postJsonWithReauth } from "../session.js";
import { collectFiles, readSkidMarker } from "./publish.js";

/**
 * Adds a new version under an EXISTING skid (POST /api/skills/<skid>/versions) --
 * distinct from `publish`, which always mints a brand-new skid. This is a skill's own
 * revision history, never a lineage/synthesis event.
 */
interface UpdateOptions {
  yes?: boolean;
}

export async function updateCommand(path: string, options: UpdateOptions = {}): Promise<void> {
  const skid = await readSkidMarker(path);
  if (!skid) {
    console.log(
      `\nNo record of this directory being published yet (no ${path}/.skillfn-skid marker). ` +
        `Run 'skillfn publish ${path}' first.`,
    );
    process.exitCode = 1;
    return;
  }

  let scanResult;
  try {
    scanResult = await runScan(path, { context: "publish", autoYes: options.yes });
  } catch (err) {
    if (err instanceof SkillSpectorRequiredError) {
      console.log(`\nUpdate aborted: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (!scanResult.passed) {
    console.log("\nUpdate aborted: the security scan did not pass. Run 'skillfn scan' for details.");
    process.exitCode = 1;
    return;
  }

  const files = await collectFiles(path);

  console.log(`\nPublishing update to ${skid}…`);
  const response = await postJsonWithReauth(`${HUB_URL}/api/skills/${skid}/versions`, {
    files,
    clientScan: scanResult,
  });

  type FindingLike = { severity?: string; rule?: string; message?: string; file?: string };
  const result = (await response.json()) as {
    error?: string;
    clientFindings?: FindingLike[];
    serverFindings?: FindingLike[];
    skid?: string;
    versionNumber?: number;
    url?: string;
  };

  if (!response.ok) {
    console.log(`\nUpdate failed: ${result.error ?? response.statusText}`);
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

  console.log(`\nPublished version ${result.versionNumber} of ${result.skid}`);
  console.log(`View it at: ${result.url}\n`);
}
