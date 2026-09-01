#!/usr/bin/env node
import { Command } from "commander";
import { scanCommand } from "./commands/scan.js";
import { auditCommand } from "./commands/audit.js";
import { pullCommand } from "./commands/pull.js";
import { publishCommand } from "./commands/publish.js";
import { updateCommand } from "./commands/update.js";
import { linkCommand } from "./commands/link.js";
import { watchCommand } from "./commands/watch.js";
import { configGetCommand, configSetCommand, configUnmuteCommand } from "./commands/config.js";
import { login } from "./session.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { completionCommand } from "./commands/completion.js";

const program = new Command();

program
  .name("skillfn")
  .description("Skillfn CLI — scan, audit, and publish AI agent skills.")
  .version("0.1.0");

program
  .command("scan <path>")
  .description("Run the local security scanner against a skill directory (no network required).")
  .option("--format <format>", "terminal (default), json, or sarif (for GitHub Code Scanning / VS Code)", "terminal")
  .option("--yes", "auto-accept the SkillSpector install offer if it's missing, non-interactively")
  .action(scanCommand);

program
  .command("audit")
  .description("Find unused or likely-duplicate skills installed locally (no network required).")
  .action(auditCommand);

program
  .command("link [skillName]")
  .description(
    "Make a locally installed skill available to another platform too (no hub required). " +
      "Run with no arguments for an interactive picker, or 'skillfn link my-skill --to openclaw' " +
      "(or '--to all') for scripts/AI agents.",
  )
  .option("--to <platform>", "target platform id, or 'all' -- skips the interactive picker when given with <skillName>")
  .action(linkCommand);

program
  .command("watch")
  .description(
    "Foreground, opt-in watcher for newly-appeared local skills — nudges toward publishing " +
      "per 'skillfn config' settings. Never installs a background daemon; Ctrl+C to stop.",
  )
  .action(watchCommand);

const configCmd = program
  .command("config")
  .description("Manage skillfn's local settings (~/.skillfn/config.json, no telemetry).");

configCmd
  .command("get [key]")
  .description("Show a config value, or the whole config if no key is given.")
  .action(configGetCommand);

configCmd
  .command("set <key> <value>")
  .description("Set a config value — e.g. 'skillfn config set publish-prompts ask'.")
  .action(configSetCommand);

configCmd
  .command("unmute <skillName>")
  .description("Undo a permanent 'never ask about this skill again' from skillfn watch.")
  .action(configUnmuteCommand);

program
  .command("login")
  .description("Sign in to the hub via your browser (also triggered automatically by 'publish' if needed).")
  .action(async () => {
    await login();
  });

program
  .command("pull <skid>")
  .description("Fetch a published skill from the hub. (Not yet implemented — Phase 3+.)")
  .action(pullCommand);

program
  .command("publish <path>")
  .description("Scan, then publish a skill to the hub — signs and mints a persistent SKID.")
  .option("--license <spdxIdOrText>", "skip the interactive license prompt")
  .option("--original-source <url>", "skip the interactive originality prompt: this is based on existing work at <url>")
  .option("--original-author <handle>", "original author's handle, if known (used with --original-source)")
  .option("--yes", "auto-accept the SkillSpector install offer if it's missing, non-interactively")
  .action(publishCommand);

program
  .command("update <path>")
  .description("Scan, then publish a new version of an already-published skill (same SKID, new skill_versions row).")
  .option("--yes", "auto-accept the SkillSpector install offer if it's missing, non-interactively")
  .action(updateCommand);

program
  .command("init")
  .description("Scaffold a new, scan-clean SKILL.md from a short interactive prompt.")
  .action(initCommand);

program
  .command("doctor")
  .description("Diagnose common problems: is skillspector installed, is your session valid, any broken 'link' symlinks.")
  .option("--yes", "auto-accept the SkillSpector install offer if it's missing, non-interactively")
  .action(doctorCommand);

program
  .command("completion <shell>")
  .description("Print a shell completion script for bash, zsh, or fish (pipe/redirect it yourself).")
  .action(completionCommand);

program.parseAsync(process.argv);
