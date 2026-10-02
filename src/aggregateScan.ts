import { skillSpectorScanner } from "./scanner/skillSpectorScanner.js";
import type { Finding, Severity } from "./scanner/types.js";
import type { FoundSkill } from "./skillTreeDiscovery.js";
import { ThreadedProgress } from "./threadedProgress.js";

export interface UniqueRisk {
  rule: string;
  severity: Severity;
  message: string;
  count: number;
  locations: string[]; // "dir/file:line", capped
}

export interface AggregatedSkill {
  name: string;
  description: string;
  instances: string[]; // absolute skill directory paths
  severityCounts: Partial<Record<Severity, number>>;
  totalFindings: number;
  uniqueRisks: UniqueRisk[]; // sorted by severity, highest first
}

export interface AggregateReport {
  skills: AggregatedSkill[];
  totalInstancesScanned: number;
  scanErrors: number;
  elapsedMs: number;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const MAX_LOCATIONS_SHOWN = 3;

/**
 * Builds one AggregatedSkill from a flat list of (finding, source-directory) pairs --
 * shared by runAggregateScan (one per distinct skill name, across however many instances
 * it found) and a single `skillfn scan <path>` (exactly one instance), so a single-skill
 * scan renders with the identical template as a multi-skill one instead of a bespoke format.
 */
export function buildAggregatedSkill(
  name: string,
  description: string,
  findings: Array<{ finding: Finding; dir: string }>,
  instances: string[],
): AggregatedSkill {
  const severityCounts: Partial<Record<Severity, number>> = {};
  const uniqueMap = new Map<string, UniqueRisk>();
  for (const { finding, dir } of findings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
    const key = `${finding.rule}::${finding.severity}::${finding.message}`;
    const loc = finding.line ? `${dir}/${finding.file}:${finding.line}` : `${dir}/${finding.file}`;
    const existing = uniqueMap.get(key);
    if (existing) {
      existing.count++;
      if (existing.locations.length < MAX_LOCATIONS_SHOWN) existing.locations.push(loc);
    } else {
      uniqueMap.set(key, { rule: finding.rule, severity: finding.severity, message: finding.message, count: 1, locations: [loc] });
    }
  }
  const uniqueRisks = [...uniqueMap.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return {
    name,
    description,
    instances: [...new Set(instances)],
    severityCounts,
    totalFindings: findings.length,
    uniqueRisks,
  };
}

/**
 * Runs `tasks` with at most `limit` running concurrently -- SkillSpector's own process
 * start cost (cold Python interpreter) makes unlimited parallelism counterproductive, and
 * unbounded concurrency on a real machine with dozens of skills could exhaust memory/CPU.
 * Each of the `limit` lanes keeps a stable index for its whole lifetime (it just pulls the
 * next item when free), which ThreadedProgress uses as that lane's fixed display row.
 */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, lane: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function lane(laneIndex: number): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], laneIndex);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, (_, i) => lane(i)));
}

export interface RunAggregateScanOptions {
  concurrency?: number;
  /** Where the live progress (and any streamed skill block, see onSkillReady) is drawn.
   * Defaults to stderr so --format json/sarif's stdout stays pure; the terminal-format
   * caller passes stdout instead so streamed blocks land where a human would redirect or
   * page the actual report, with the progress footer riding along on the same stream. */
   progressOutput?: NodeJS.WriteStream;
  /**
   * Called the instant a skill's LAST instance finishes (every instance of a given name
   * must finish before that name is "done" -- printing a partial, still-updating block
   * for the same skill would be more confusing than waiting the extra moment). Returning
   * a string streams it immediately, above the still-running progress rows, Claude-chat-
   * output style, instead of waiting for every skill in the batch to finish first.
   */
  onSkillReady?: (skill: AggregatedSkill) => string | void;
}

/**
 * Scans each discovered skill directory individually (never one scan across a huge tree --
 * that's slow and produces findings with no clear owning skill) and groups the results by
 * skill name, since the same skill can legitimately exist in multiple places (an active
 * copy plus an archived snapshot, a monorepo with several packages vendoring it, etc.).
 */
export async function runAggregateScan(skills: FoundSkill[], options: RunAggregateScanOptions = {}): Promise<AggregateReport> {
  const concurrency = options.concurrency ?? 4;
  const start = Date.now();
  const byName = new Map<
    string,
    { description: string; instances: string[]; findings: Array<{ finding: Finding; dir: string }>; remaining: number }
  >();
  for (const skill of skills) {
    const entry = byName.get(skill.name) ?? { description: skill.description, instances: [], findings: [], remaining: 0 };
    entry.remaining++;
    byName.set(skill.name, entry);
  }
  let scanErrors = 0;

  const progress = new ThreadedProgress(skills.length, concurrency, options.progressOutput);
  progress.start();

  const ready: AggregatedSkill[] = [];

  await runWithConcurrency(skills, concurrency, async (skill, lane) => {
    progress.assign(lane, skill.name);
    let ok = true;
    const entry = byName.get(skill.name)!;
    try {
      const result = await skillSpectorScanner.scan(skill.dir);
      entry.instances.push(skill.dir);
      for (const finding of result.findings) entry.findings.push({ finding, dir: skill.dir });
    } catch {
      ok = false;
      scanErrors++;
    } finally {
      progress.complete(lane, ok);
      entry.remaining--;
      if (entry.remaining === 0) {
        const built = buildAggregatedSkill(skill.name, entry.description, entry.findings, entry.instances);
        ready.push(built);
        const text = options.onSkillReady?.(built);
        if (text) progress.print(text);
      }
    }
  });

  progress.stop(`Scanned ${skills.length} skill instance(s).`);

  const worstSeverity = (skill: AggregatedSkill): number =>
    Math.max(0, ...Object.entries(skill.severityCounts).map(([sev, n]) => (n ? SEVERITY_RANK[sev as Severity] : -1)));
  ready.sort((a, b) => worstSeverity(b) - worstSeverity(a));

  return { skills: ready, totalInstancesScanned: skills.length, scanErrors, elapsedMs: Date.now() - start };
}
