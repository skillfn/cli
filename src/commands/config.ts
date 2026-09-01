import { loadConfig, saveConfig, setPublishPrompts, type PublishPrompts, CONFIG_PATH } from "../config.js";

const VALID_PUBLISH_PROMPTS: PublishPrompts[] = ["always", "ask", "never"];

export async function configGetCommand(key?: string): Promise<void> {
  const config = await loadConfig();
  if (key === undefined) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (key === "publish-prompts") {
    console.log(config.publishPrompts);
    return;
  }
  console.log(`Unknown config key "${key}". Known keys: publish-prompts.`);
  process.exitCode = 1;
}

export async function configSetCommand(key: string, value: string): Promise<void> {
  if (key !== "publish-prompts") {
    console.log(`Unknown config key "${key}". Known keys: publish-prompts.`);
    process.exitCode = 1;
    return;
  }
  if (!VALID_PUBLISH_PROMPTS.includes(value as PublishPrompts)) {
    console.log(`Invalid value "${value}" for publish-prompts. Valid: ${VALID_PUBLISH_PROMPTS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  await setPublishPrompts(value as PublishPrompts);
  console.log(`publish-prompts set to "${value}" (saved to ${CONFIG_PATH}).`);
}

export async function configUnmuteCommand(skillName: string): Promise<void> {
  const config = await loadConfig();
  config.mutedSkills = config.mutedSkills.filter((s) => s !== skillName);
  await saveConfig(config);
  console.log(`"${skillName}" unmuted — you'll be asked about it again.`);
}
