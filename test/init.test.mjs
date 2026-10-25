import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCANNER = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.0; exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    printf '{"issues":[],"analysis_completeness":{"is_complete":true}}' > "$1"
    exit 0
  fi
  shift
done
exit 1
`;

/**
 * Builds a fake HOME with a project, a codex session pointing at it, a fake `skillspector`
 * on PATH, and one skill folder. Restores HOME, PATH, cwd, and fetch afterwards.
 */
async function withFixture(prefix, { skillDir, manifest, markers = [] }, body) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const previous = { home: process.env.HOME, path: process.env.PATH, cwd: process.cwd(), fetch: globalThis.fetch };
  try {
    process.env.HOME = home;
    process.env.PATH = `${join(home, "bin")}:${previous.path}`;
    const project = join(home, "project");
    const skill = join(home, skillDir);
    const sessions = join(home, ".codex", "sessions", "2026", "10", "08");
    await Promise.all([project, skill, sessions, join(home, "bin"), ...markers.map((m) => join(home, m))]
      .map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(skill, manifest), "---\nname: demo\ndescription: Example skill\n---\n# Demo\n");
    await writeFile(join(sessions, "session.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: project } }) + "\n");
    await writeFile(join(home, "bin", "skillspector"), SCANNER, { mode: 0o755 });
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "0.4.2" }), { status: 200 });
    process.chdir(project);
    await body({ home, project, skill });
  } finally {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    globalThis.fetch = previous.fetch;
    await rm(home, { recursive: true, force: true });
  }
}

const readIndex = async (home) => JSON.parse(await readFile(join(home, ".skillfn", "index.json"), "utf8"));

test("discovers Claude Code and Codex sessions from their cwd metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "skillfn-sessions-"));
  try {
    const project = join(home, "project");
    const claude = join(home, ".claude", "projects", "encoded-project");
    const codex = join(home, ".codex", "sessions", "2026", "10", "08");
    await Promise.all([project, claude, codex].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(claude, "a.jsonl"), JSON.stringify({ type: "user", cwd: project }) + "\n");
    await writeFile(join(codex, "b.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: project } }) + "\n");
    await writeFile(join(codex, "stale.jsonl"), JSON.stringify({ payload: { cwd: join(home, "missing") } }) + "\n");
    const { discoverCodingSessions } = await import("../dist/initDiscovery.js");
    const sessions = await discoverCodingSessions(home);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((session) => session.provider).sort(), ["claude-code", "codex"]);
    assert.ok(sessions.every((session) => session.project === project));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("init --yes --rename --link scans, normalizes, indexes, and links a passing skill", async () => {
  await withFixture("skillfn-init-", { skillDir: ".claude/skills/demo", manifest: "skill.md" }, async ({ home, project, skill }) => {
    const { initCommand } = await import("../dist/commands/init.js");
    await initCommand({ yes: true, rename: true, link: true });
    const index = await readIndex(home);
    assert.equal(index.sessions.length, 1);
    assert.equal(index.lookup.byProject[project].sessions.codex, 1);
    assert.equal(index.skills[0].scan, "passed");
    assert.equal(index.skills[0].manifest, "SKILL.md");
    assert.equal(await realpath(join(home, ".agents", "skills", "demo")), skill);
    await initCommand({ yes: true, rename: true, link: true });
    const rerun = await readIndex(home);
    assert.equal(rerun.links.length, 1);
    assert.deepEqual(rerun.conflicts, []);
  });
});

test("re-running init keeps a link for a skill that lives in the codex directory", async () => {
  // ~/.claude marks claude-code as an active provider, so the codex-origin skill gets linked there.
  await withFixture("skillfn-init-codex-", { skillDir: ".agents/skills/codex-only", manifest: "SKILL.md", markers: [".claude"] }, async ({ home, skill }) => {
    const { initCommand } = await import("../dist/commands/init.js");
    await initCommand({ yes: true, link: true });
    const first = await readIndex(home);
    assert.equal(first.links.length, 1);
    assert.equal(await realpath(join(home, ".claude", "skills", "codex-only")), skill);
    await initCommand({ yes: true, link: true });
    const rerun = await readIndex(home);
    assert.equal(rerun.links.length, 1);
    assert.deepEqual(rerun.conflicts, []);
  });
});

test("--yes alone scans but does not rename or link", async () => {
  await withFixture("skillfn-init-yes-", { skillDir: ".claude/skills/demo", manifest: "skill.md" }, async ({ home, skill }) => {
    const { initCommand } = await import("../dist/commands/init.js");
    await initCommand({ yes: true });
    const index = await readIndex(home);
    assert.equal(index.skills[0].scan, "passed");
    assert.equal(index.skills[0].manifest, "skill.md");
    assert.equal(index.links.length, 0);
    await readFile(join(skill, "skill.md"), "utf8");
    await assert.rejects(lstat(join(skill, "SKILL.md")));
    await assert.rejects(lstat(join(home, ".agents", "skills", "demo")));
  });
});

test("--dry-run changes nothing and saves no index", async () => {
  await withFixture("skillfn-init-dry-", { skillDir: ".claude/skills/demo", manifest: "skill.md" }, async ({ home, skill }) => {
    const { initCommand } = await import("../dist/commands/init.js");
    await initCommand({ yes: true, rename: true, link: true, dryRun: true });
    await readFile(join(skill, "skill.md"), "utf8");
    await assert.rejects(lstat(join(skill, "SKILL.md")));
    await assert.rejects(lstat(join(home, ".agents", "skills", "demo")));
    await assert.rejects(lstat(join(home, ".skillfn", "index.json")));
  });
});
