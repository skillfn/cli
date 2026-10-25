import { mkdir, lstat, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { doctorCommand, isSkillSpectorInstalled } from "./doctor.js";
import { discoverInitInventory } from "../initDiscovery.js";
import { PLATFORMS } from "../platforms.js";
import { CANONICAL_SKILL_MD } from "../skillMdFile.js";
import { skillSpectorScanner } from "../scanner/skillSpectorScanner.js";
import type { Finding } from "../scanner/types.js";
import { checkSkillReferences, type BrokenReference } from "../brokenReferences.js";
import type { DiscoveredSkill } from "../skillDiscovery.js";
import { dim, failure, note, skillListLabel, success, truncateHint, warn } from "../ui.js";

/**
 * --yes answers prompts with their safe defaults: it scans, but never installs, renames, or
 * links on its own. Each side effect needs its own flag. --dry-run changes nothing at all.
 */
interface InitOptions {
  yes?: boolean;
  installScanner?: boolean;
  rename?: boolean;
  link?: boolean;
  dryRun?: boolean;
}
type ScanState = "passed" | "failed" | "incomplete" | "error" | "skipped";
interface SkillRecord {
  name: string;
  dir: string;
  provider: string;
  scope: "global" | "project";
  manifest: string;
  manifestValid: boolean;
  scan: ScanState;
  findings?: number;
  securityFindings?: Finding[];
  referenceIssues?: BrokenReference[];
}

/** Resolved per call (not at import) so the location follows the current HOME. */
function indexPath(): string {
  return join(homedir(), ".skillfn", "index.json");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function saveIndex(data: object): Promise<void> {
  await mkdir(dirname(indexPath()), { recursive: true });
  const temporary = `${indexPath()}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, indexPath());
}

async function uniqueSources(skills: DiscoveredSkill[]): Promise<DiscoveredSkill[]> {
  const seen = new Set<string>();
  const unique: DiscoveredSkill[] = [];
  for (const skill of skills) {
    // Canonicalize to the real folder: a copy reached through a link (e.g. ~/.claude/skills/x -> ~/.agents/skills/x)
    // is the same skill, and linking must compare against the real path or re-runs report false conflicts.
    const dir = await realpath(skill.dir).catch(() => resolve(skill.dir));
    if (seen.has(dir)) continue;
    seen.add(dir);
    unique.push({ ...skill, dir });
  }
  return unique;
}

/** Only paths under discovered provider roots are linked; no unrelated folders are created. */
function linkTargets(source: DiscoveredSkill, projects: string[], activeProviders: string[]): string[] {
  const home = homedir();
  const targets = new Set<string>();
  for (const platform of PLATFORMS.filter((item) => activeProviders.includes(item.id))) {
    if (source.scope === "global") {
      if (platform.globalDir) targets.add(join(platform.globalDir(home), basename(source.dir)));
      else for (const project of projects) targets.add(join(platform.projectDir(project), basename(source.dir)));
    } else {
      // Project skill roots are known by their provider. Use their owning project only.
      const owningProject = projects.find((item) =>
        PLATFORMS.some((candidate) => candidate.projectDir(item) === dirname(source.dir)));
      if (owningProject) targets.add(join(platform.projectDir(owningProject), basename(source.dir)));
    }
  }
  targets.delete(resolve(source.dir));
  return [...targets];
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  p.intro("skillfn init");
  const inventoryNote = options.dryRun ? "Dry run: nothing saved" : `Inventory saved to ${indexPath()}`;
  await doctorCommand({
    yes: options.installScanner,
    declineInstall: options.dryRun || (options.yes && !options.installScanner),
  });

  // Discovery reads every session transcript header and walks every project's skill roots, which
  // is silent and slow on a machine with many sessions -- show live status so it doesn't read as hung.
  const discovering = p.spinner({ indicator: "timer" });
  discovering.start("Discovering coding sessions and skills");
  const inventory = await discoverInitInventory(process.cwd(), homedir(), (message) => discovering.message(message));
  const sources = await uniqueSources(inventory.skills);
  discovering.stop("Discovery complete.");
  p.log.info(`Found ${inventory.sessions.length} Claude Code/Codex session(s), ${inventory.projects.length} project(s), ${sources.length} skill source(s), and ${inventory.activeProviders.length} active provider(s).`);
  const records: SkillRecord[] = sources.map((skill) => ({
    name: skill.name, dir: skill.dir, provider: skill.platform.id, scope: skill.scope,
    manifest: skill.manifestFilename, manifestValid: skill.manifestValid !== false, scan: "skipped",
  }));
  const links: Array<{ source: string; target: string }> = [];
  const conflicts: string[] = [];
  const bySkill: Record<string, string[]> = {};
  const byProject: Record<string, { sessions: Record<string, number>; skills: string[] }> = {};
  for (const project of inventory.projects) byProject[project] = { sessions: {}, skills: [] };
  for (const session of inventory.sessions) {
    const counts = byProject[session.project]?.sessions;
    if (counts) counts[session.provider] = (counts[session.provider] ?? 0) + 1;
  }
  for (const record of records) {
    (bySkill[record.name] ??= []).push(record.dir);
    const project = inventory.projects.find((item) =>
      PLATFORMS.some((candidate) => candidate.projectDir(item) === dirname(record.dir)));
    if (project) byProject[project].skills.push(record.dir);
  }
  const write = () => options.dryRun ? Promise.resolve() : saveIndex({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    providers: inventory.activeProviders,
    supportedProviders: PLATFORMS.map((platform) => platform.id),
    projects: inventory.projects,
    sessions: inventory.sessions,
    skills: records,
    lookup: { byProject, bySkill },
    links,
    conflicts,
  });
  await write();
  if (sources.length === 0) { p.outro(`${inventoryNote}. No skills found.`); return; }

  const invalid = sources.filter((skill) => skill.manifestValid === false);
  if (invalid.length) p.log.warn(`${invalid.length} skill manifest(s) have invalid or missing YAML frontmatter; see the index. They will not be linked.`);

  let selected = sources;
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      p.log.warn(`${inventoryNote}. Run interactively to choose skills, or pass --yes to scan all discovered skills.`);
      return;
    }
    const selection = await p.multiselect({
      message: "Which discovered skills may skillfn scan? (space to select)",
      options: sources.map((skill, index) => ({
        value: index,
        label: skillListLabel(skill.name, `${skill.platform.label}, ${skill.scope}`),
        hint: truncateHint(skill.dir, 90),
      })),
      required: false,
    });
    if (p.isCancel(selection)) { p.cancel("Cancelled after saving inventory."); return; }
    selected = (selection as number[]).map((index) => sources[index]);
  }
  if (selected.length === 0) { p.outro(`${inventoryNote}. Scan skipped.`); return; }

  const nonCanonical = selected.filter((skill) => skill.manifestFilename !== CANONICAL_SKILL_MD);
  if (nonCanonical.length > 0) {
    if (options.dryRun) for (const skill of nonCanonical) p.log.info(`Would rename ${join(skill.dir, skill.manifestFilename)} to ${CANONICAL_SKILL_MD}`);
    // --yes defaults to No here; only --rename consents without a prompt, and a dry run changes nothing.
    const fix = options.dryRun ? false : options.rename || (options.yes ? false : await p.confirm({
      message: `Rename ${nonCanonical.length} noncanonical skill.md filename(s) to SKILL.md?`, initialValue: true,
    }));
    if (!p.isCancel(fix) && fix) {
      for (const skill of nonCanonical) {
        const target = join(skill.dir, CANONICAL_SKILL_MD);
        // lstat(target) also finds skill.md on case-insensitive filesystems.
        // Check the on-disk spelling so a case-only rename remains possible.
        const hasExact = (await readdir(skill.dir)).includes(CANONICAL_SKILL_MD);
        if (hasExact) { conflicts.push(`Manifest exists: ${target}`); continue; }
        try {
          await rename(join(skill.dir, skill.manifestFilename), target);
          skill.manifestFilename = CANONICAL_SKILL_MD;
          records.find((record) => record.dir === skill.dir)!.manifest = CANONICAL_SKILL_MD;
        } catch (error) { conflicts.push(`Could not rename ${skill.dir}: ${String(error)}`); }
      }
    }
  }

  if (!await isSkillSpectorInstalled()) {
    await write();
    p.outro(`${inventoryNote}. Scanner unavailable; scan and linking skipped.`);
    return;
  }

  for (const [index, skill] of selected.entries()) {
    const record = records.find((item) => item.dir === skill.dir)!;
    // SkillSpector can take a while with no output of its own (cold start on first run), so each
    // skill gets its own timer spinner rather than one silent wait for the whole batch.
    const scanning = p.spinner({ indicator: "timer" });
    scanning.start(`Scanning ${skill.name} (${index + 1}/${selected.length})`);
    try {
      const result = await skillSpectorScanner.scan(skill.dir);
      record.securityFindings = result.findings;
      record.findings = result.findings.filter((finding) => !finding.isCoverageLimitation).length;
      record.scan = result.completeness && !result.completeness.isComplete ? "incomplete" : result.passed ? "passed" : "failed";
      scanning.message(`Checking local references in ${skill.name}`);
      const references = await checkSkillReferences(skill.dir, { links: true, prose: false, urls: false });
      record.referenceIssues = references.broken;
      scanning.stop(`${skill.name}: ${record.scan}`);
      const detail = `${record.findings} security finding(s), ${references.broken.length} broken local reference(s)`;
      p.log.message(`${record.scan === "passed" ? success(detail) : record.scan === "failed" ? failure(detail) : note(detail)}\n${dim(skill.dir)}`);
      if (record.scan !== "passed") {
        for (const finding of result.findings.filter((item) => !item.isCoverageLimitation &&
          (item.severity === "high" || item.severity === "critical")).slice(0, 3)) {
          p.log.warn(`${finding.severity.toUpperCase()} ${finding.file}: ${finding.message}`);
        }
        for (const reason of result.completeness?.limitations.slice(0, 2) ?? []) p.log.message(note(reason));
      }
    } catch (error) {
      record.scan = "error";
      conflicts.push(`Scan error for ${skill.dir}: ${String(error)}`);
      scanning.error(`${skill.name}: scan error`);
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
  await write();
  const passed = selected.filter((skill) => {
    const record = records.find((item) => item.dir === skill.dir);
    return record?.scan === "passed" && record.manifestValid;
  });
  const tally = (state: ScanState) => selected.filter((skill) => records.find((item) => item.dir === skill.dir)?.scan === state).length;
  p.log.message([
    `Scan summary: ${selected.length} scanned`,
    `  ${success(`${tally("passed")} passed`)}`,
    `  ${tally("failed") ? failure(`${tally("failed")} failed`) : dim("0 failed")}`,
    `  ${tally("incomplete") ? note(`${tally("incomplete")} incomplete (scanner could not fully analyze)`) : dim("0 incomplete")}`,
    `  ${tally("error") ? warn(`${tally("error")} errored`) : dim("0 errored")}`,
  ].join("\n"));
  if (passed.length === 0) {
    process.exitCode = 1;
    p.outro(`${inventoryNote}. No scanned skills passed for linking.`);
    return;
  }

  const plan = passed.flatMap((skill) => linkTargets(skill, inventory.projects, inventory.activeProviders).map((target) => ({ skill, target })));
  if (plan.length > 0) {
    if (options.dryRun) for (const { skill, target } of plan) p.log.info(`Would link ${target} -> ${skill.dir}`);
    // --yes defaults to No here; only --link consents without a prompt, and a dry run changes nothing.
    const confirm = options.dryRun ? false : options.link || (options.yes ? false : await p.confirm({
      message: `Create up to ${plan.length} symlink(s) for ${passed.length} passed skill(s) across active providers? Existing paths will be skipped.`,
      initialValue: false,
    }));
    if (!p.isCancel(confirm) && confirm) {
      for (const { skill, target } of plan) {
        if (await exists(target)) {
          const same = (await lstat(target)).isSymbolicLink() && await Promise.all([realpath(target), realpath(skill.dir)]).then(
            ([linked, source]) => linked === source, () => false,
          );
          if (same) links.push({ source: skill.dir, target });
          else conflicts.push(`Already exists: ${target}`);
          continue;
        }
        try {
          await mkdir(dirname(target), { recursive: true });
          await symlink(skill.dir, target, "dir");
          links.push({ source: skill.dir, target });
        } catch (error) { conflicts.push(`Could not link ${target}: ${String(error)}`); }
      }
    }
  }
  await write();
  if (records.some((record) => !record.manifestValid || record.scan === "failed" || record.scan === "incomplete" || record.scan === "error")) process.exitCode = 1;
  if (options.dryRun) {
    p.outro(`Dry run: nothing was changed or saved. ${plan.length} link(s) planned.`);
    return;
  }
  p.outro(`Saved ${indexPath()}: ${records.filter((record) => record.scan === "passed").length} passed, ${links.length} links created, ${conflicts.length} conflict(s).`);
}
