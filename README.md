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
skillfn scan ./path/to/some-skill
skillfn scan ./path/to/some-skill --format sarif   # for GitHub Code Scanning / VS Code
skillfn scan ./path/to/some-skill --format json
```

## `init` — scaffold a new skill

Prompts for a name/description (and whether it needs network/exec) and writes a scan-clean `SKILL.md` skeleton, so a first `scan` isn't a cold start.

```
skillfn init
```

## `doctor` — diagnose common problems

Checks whether `skillspector` is on PATH, whether your hub session is actually still valid (not just "a file exists"), and for any broken `skillfn link` symlinks.

```
skillfn doctor
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
