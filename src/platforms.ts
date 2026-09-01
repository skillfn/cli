import { join } from "node:path";

export type NetworkPosture = "full" | "none" | "configurable-sandbox";

export interface PlatformInfo {
  id: string;
  label: string;
  /** Optional because some platforms genuinely have no per-user/global skill directory
   * (confirmed for Windsurf — project-local only) — that's a real fact, not a gap to guess past. */
  globalDir?: (home: string) => string;
  projectDir: (cwd: string) => string;
  /**
   * Confirmed network-access posture, only where independently verified — see
   * extra/plans/08-cross-platform-capabilities.md. `undefined` means "not verified,
   * check manually before relying on it," never a guess.
   */
  networkPosture?: NetworkPosture;
}

/**
 * Only platforms whose skill-discovery directory convention was independently
 * confirmed against a primary source are listed here (extra/plans/08-cross-platform-capabilities.md).
 *
 * Codex CLI and Antigravity both confirmed (primary docs, not secondary sources) to use
 * `.agents/skills` for project-local discovery — the same directory. That means linking
 * a project-scoped skill to either target effectively satisfies both; `skillfn link`
 * still lists them separately since their global paths differ, but the second link will
 * report "already exists" rather than duplicate anything. This is the shared-alias
 * convention flagged earlier as unconfirmed — it is now confirmed for these two.
 */
export const PLATFORMS: PlatformInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    globalDir: (home) => join(home, ".claude", "skills"),
    projectDir: (cwd) => join(cwd, ".claude", "skills"),
    networkPosture: "full",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    globalDir: (home) => join(home, ".openclaw", "skills"),
    projectDir: (cwd) => join(cwd, ".openclaw", "skills"),
    // Network posture not independently verified — OpenClaw's docs confirm format
    // parity with Claude Code but not its default sandbox/network policy.
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    globalDir: (home) => join(home, ".hermes", "skills"),
    // Hermes is primarily a personal agent gateway; a project-local convention was
    // not confirmed. Falling back to the global dir is a reasonable default, not a
    // verified fact.
    projectDir: (cwd) => join(cwd, ".hermes", "skills"),
  },
  {
    id: "cursor",
    label: "Cursor",
    globalDir: (home) => join(home, ".cursor", "skills"),
    projectDir: (cwd) => join(cwd, ".cursor", "skills"),
    // Configurable 3-tier sandbox via sandbox.json (allowlist-only, allowlist+defaults,
    // or allow-all) — confirmed, but not a single fixed posture like "full" or "none".
    networkPosture: "configurable-sandbox",
  },
  {
    // Gemini CLI was retired: Google announced its replacement by Antigravity CLI
    // (developers.googleblog.com, May 2026), with Gemini CLI's sunset on 2026-06-18.
    // An earlier version of this file had a "gemini-cli" entry at ~/.gemini/skills —
    // that was wrong on both counts (superseded product, and even Antigravity doesn't
    // use that exact path). Corrected here against antigravity.google/docs/skills.
    id: "antigravity",
    label: "Antigravity",
    globalDir: (home) => join(home, ".gemini", "config", "skills"),
    projectDir: (cwd) => join(cwd, ".agents", "skills"),
    // Network/sandbox posture not documented on the primary page — genuinely
    // unverified, not merely unconfirmed-but-assumed. Leave undefined.
  },
  {
    // Confirmed against learn.chatgpt.com/docs/build-skills (the primary doc). Codex
    // also scans upward from cwd to the repo root for `.agents/skills` — this registry
    // only checks cwd directly, matching every other platform entry's model; the
    // upward-scan behavior is a known simplification, not a bug, until discovery is
    // generalized to walk up if this turns out to matter in practice.
    id: "codex",
    label: "OpenAI Codex CLI",
    globalDir: (home) => join(home, ".agents", "skills"),
    projectDir: (cwd) => join(cwd, ".agents", "skills"),
    // Network/sandbox posture not stated in the primary doc — an earlier secondary-
    // source claim ("sandboxed, network off by default") was not confirmed. Leave
    // undefined rather than carry an unconfirmed claim forward as fact.
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    globalDir: (home) => join(home, ".copilot", "skills"),
    projectDir: (cwd) => join(cwd, ".github", "skills"),
    // Capability/sandbox posture was not found in the verification pass — genuinely
    // unverified, not merely unconfirmed-but-assumed. Leave undefined.
  },
  {
    // opencode.ai/docs/skills confirms OpenCode ALSO natively reads ~/.claude/skills and
    // ~/.agents/skills directly, in addition to its own native path below — meaning a
    // skill already installed for Claude Code or placed under .agents/skills is already
    // visible to OpenCode with zero linking. The native path here is only needed if you
    // specifically want it to show up under OpenCode's own directory (e.g. tooling that
    // only lists native skills), not for OpenCode to see it at all.
    id: "opencode",
    label: "OpenCode",
    globalDir: (home) => join(home, ".config", "opencode", "skills"),
    projectDir: (cwd) => join(cwd, ".opencode", "skills"),
  },
  {
    // moonshotai.github.io/kimi-cli — confirmed product name is "Kimi Code," not "Kimi
    // Coder." Also searches ~/.claude/skills and ~/.codex/skills as fallbacks (priority
    // order), and separately a generic ~/.config/agents/skills / ~/.agents/skills path —
    // registered here is only its own branded native path.
    id: "kimi-code",
    label: "Kimi Code",
    globalDir: (home) => join(home, ".kimi", "skills"),
    projectDir: (cwd) => join(cwd, ".kimi", "skills"),
  },
  {
    // github.com/Kilo-Org — project-local takes precedence over global on a name collision.
    id: "kilo-code",
    label: "Kilo Code",
    globalDir: (home) => join(home, ".kilo", "skills"),
    projectDir: (cwd) => join(cwd, ".kilo", "skills"),
  },
  {
    // Confirmed (multiple corroborating docs): Windsurf has NO global/per-user skill
    // directory at all, project-local only — hence no globalDir here, not an oversight.
    // Also discovers .agents/skills/, and .claude/skills/ if Claude-config-reading is
    // enabled, for cross-agent compatibility. A secondary-source claim of a
    // ~/.codeium/windsurf/skills/ global path was NOT corroborated by a primary doc —
    // deliberately not added.
    id: "windsurf",
    label: "Windsurf",
    projectDir: (cwd) => join(cwd, ".windsurf", "skills"),
  },
];

export function findPlatform(id: string): PlatformInfo | undefined {
  return PLATFORMS.find((p) => p.id === id);
}
