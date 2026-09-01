# skillfn

Security-checked, not just copy-pasted: scan, sign, and publish AI agent skills (`SKILL.md`) with a real security gate, a persistent verifiable identity, and visible credit when someone forks or improves your work — works with any `SKILL.md`-compatible agent (Claude Code, Cursor, Codex, and more), not just one.

```
npm install -g skillfn
```

## `scan` — security gate

Primary engine is [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector) (Apache 2.0, runs fully offline, no API key). If it's not installed, `skillfn scan`/`publish`/`update`/`doctor` will interactively offer to install it for you the first time they need it (`uv tool install git+https://github.com/NVIDIA/skillspector.git` under the hood) — pass `--yes` to accept that offer non-interactively (e.g. in a script), or just install it yourself upfront:

```
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

This is a real interactive prompt, not something bundled into `npm install -g` itself — a postinstall script that silently fetches and runs another language's toolchain is exactly the kind of pattern this project's own scanner flags as risky in other people's skills, and it would also just silently do nothing for anyone who runs `npm install --ignore-scripts` (common in the security-conscious environments this tool is actually for).

If SkillSpector isn't installed and you decline the offer, `skillfn scan` falls back to a built-in, zero-dependency pattern-based scanner covering a narrower rule set (dangerous shell patterns, credential-file exfiltration, unpinned insecure fetches, prompt-injection markers, concealment characters, and description/behavior mismatches) — real, but no substitute for SkillSpector's AST/taint analysis. `skillfn publish`/`update` will say so more insistently, since a "passed" scan on a published skill is meant to mean something.

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
skillfn link my-skill --to openclaw
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
