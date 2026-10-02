# skillfn

Security-checked, not just copy-pasted: scan, sign, and publish AI agent skills (`SKILL.md`) with a real security gate, a persistent verifiable identity, and visible credit when someone forks or improves your work — works with any `SKILL.md`-compatible agent (Claude Code, Cursor, Codex, and more), not just one.

```
npm install -g skillfn
```

## `scan` — security gate

**Required**: [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector) (Apache 2.0, runs fully offline, no API key), and `uv` (a Python tool manager) to install it. If either is missing, `skillfn scan`/`publish`/`update`/`doctor` show an interactive menu — *install it for me* / *just show me the command* / *cancel* — the first time they need it. Pass `--yes` to accept "install it for me" non-interactively (e.g. in a script), or just install it yourself upfront:

```
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

`scan`/`publish`/`update` require it — declining the offer or running non-interactively means they exit without producing a result rather than proceeding some other way.

```
skillfn scan ./path/to/some-skill                   # one skill (has its own SKILL.md)
skillfn scan ./path/to/a/project                     # a container folder: finds every skill under it,
                                                      # scans each individually, reports them grouped by skill
skillfn scan                                         # no path: interactive picker (everywhere skillfn
                                                      # knows about / a path you type / pick installed skills)
skillfn scan ./path/to/some-skill --format sarif     # for GitHub Code Scanning / VS Code
skillfn scan ./path/to/some-skill --format json
skillfn scan ./path/to/some-skill --full             # terminal output: show every finding, not just critical/high
```

Terminal output is grouped by skill (name, description, which directories it was found in, a risk breakdown, then its risks grouped by severity) — the same shape whether you scanned one skill or a hundred. Every CRITICAL/HIGH finding shows in full; MEDIUM/LOW/INFO collapse to a count by default, since scanning a large tree can return hundreds of low-signal findings that would otherwise push the ones that actually need a look off the top of your scrollback. `--full` (or `--format json`, which is always complete) shows everything. Scanning several skills runs them in parallel with a live per-skill progress line for each; afterward you can generate a Markdown report with real collapsible (`<details>`) sections per severity group, viewable in GitHub or VS Code's preview. (`--format sarif` only applies to a single skill directory for now.)

SkillSpector enforces its own resource ceilings (documented in its [ANALYSIS_RESOURCE_BOUNDS.md](https://github.com/NVIDIA/SkillSpector/blob/main/docs/ANALYSIS_RESOURCE_BOUNDS.md)) as protection against adversarial bundles at scale — not something skillfn patches around. Its default aggregate-scan deadline is 10 minutes; skillfn raises that to 30 minutes (`SKILLSPECTOR_MAX_WORKFLOW_SECONDS`) since a local, user-owned skill directory isn't the worst-case scenario that default defends against. If a scan still doesn't fully complete (a skill with an unusually large file tree), output clearly flags it ("Scan did not fully complete (NN% coverage)") rather than silently reporting a partial result as if it were whole, and the scanner's own "couldn't fully inspect X" notices are reported separately from real findings instead of being counted as confirmed risks. Set `SKILLSPECTOR_MAX_WORKFLOW_SECONDS` yourself (in seconds) to raise it further, or `SKILLSPECTOR_MAX_STATIC_ANALYSIS_SECONDS_PER_ARTIFACT` for the per-file static-analysis budget (default 300s).

## `init` — scaffold a new skill

Prompts for a name/description (and whether it needs network/exec) and writes a scan-clean `SKILL.md` skeleton, so a first `scan` isn't a cold start.

```
skillfn init
```

## `doctor` — diagnose common problems

Checks whether `skillfn` itself is up to date, whether the required security scanner is installed, whether your hub session is actually still valid (not just "a file exists"), and for any broken `skillfn link` symlinks.

```
skillfn doctor
```

## `upgrade` — update the CLI itself

Checks npm for a newer `skillfn` release and, if one exists, runs `npm install -g skillfn@latest` for you after a confirmation prompt.

```
skillfn upgrade
skillfn upgrade --yes   # skip the confirmation, for scripts
```

## `audit` — local skill hygiene

Works fully offline against skills installed in `.claude/skills/` (project) and `~/.claude/skills/` (personal): reports which are never actually triggered (scanning this machine's own Claude Code session logs for real invocation evidence, not a guess) and flags likely-duplicate skills by description overlap.

```
skillfn audit
```

## `link` — cross-platform mirroring (no hub required)

Makes a skill installed for one platform available to another, since the base `SKILL.md` format is already shared across ~40 clients — no format conversion happens, this just symlinks it into the target platform's discovery path and warns about likely capability mismatches (e.g. a skill that looks like it needs network access, on a platform whose network policy isn't full/known).

```
skillfn link                              # interactive: pick the skill and target platform(s) with arrow keys
skillfn link my-skill --to openclaw       # explicit, for scripts/AI agents
skillfn link my-skill --to all
```

Currently supports platforms whose skill directory convention is independently confirmed against primary docs: Claude Code, OpenClaw, Hermes Agent, Cursor, Antigravity (Google's Gemini CLI replacement), OpenAI Codex CLI, GitHub Copilot.

## `publish` — sign and publish to the [Skillfn Hub](https://skillfn.vercel.app)

Scans first (aborts if it fails — never publishes something that didn't pass), then prompts for a license (or skip with `--license <spdx-id-or-text>`) and whether this is your own original work (or `--original-source <url>` / `--original-author <handle>` if it's based on someone else's), then publishes. First run triggers a one-time browser sign-in automatically (`skillfn login` also exists standalone, but you never need to run it manually).

```
skillfn publish ./path/to/some-skill
skillfn publish ./path/to/some-skill --license MIT
skillfn publish ./path/to/some-skill --license MIT --original-source https://github.com/someone/their-skill
```

The content is signed server-side with a single Skillfn Hub service identity and gets a persistent, content-addressed SKID plus a `/<your-handle>/<skill-name>` URL. A `.skillfn-skid` marker is written into the skill's own directory so `skillfn update` can find it later without you having to remember the ID.

## `update` — publish a new version of an already-published skill

```
skillfn update ./path/to/some-skill
```

Same scan gate as `publish`, but keeps the same SKID and links the new content as a new version rather than a new identity — reads the `.skillfn-skid` marker `publish` already wrote.

## `pull`

Not implemented yet.

## `watch` — get nudged when a new skill appears

Foreground, opt-in filesystem watcher over your platforms' skill directories; nudges toward publishing per your `config` settings. Never installs a background daemon — Ctrl+C to stop.

```
skillfn watch
```

## `config` — local settings (no telemetry)

```
skillfn config get                          # show everything
skillfn config set publish-prompts ask      # always | ask | never (default: ask)
skillfn config unmute my-skill              # undo a permanent "never ask about this again"
```

## `completion` — shell completion

```
skillfn completion bash > /etc/bash_completion.d/skillfn
skillfn completion zsh > ~/.zsh/completions/_skillfn
skillfn completion fish > ~/.config/fish/completions/skillfn.fish
```
