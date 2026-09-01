import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local, plaintext config — no telemetry, nothing sent anywhere. Governs the publish
 * nudge described in extra/plans/09-growth-funnel-and-business-model.md: a global
 * default plus a per-skill override, the same two-tier shape as browser cookie consent
 * or an OS permission dialog ("Allow / Allow Always / Don't Ask Again").
 */
export type PublishPrompts = "always" | "ask" | "never";

export interface SkillfnConfig {
  publishPrompts: PublishPrompts;
  mutedSkills: string[];
}

const CONFIG_DIR = join(homedir(), ".skillfn");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: SkillfnConfig = {
  publishPrompts: "ask",
  mutedSkills: [],
};

export async function loadConfig(): Promise<SkillfnConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillfnConfig>;
    return {
      publishPrompts: parsed.publishPrompts ?? DEFAULT_CONFIG.publishPrompts,
      mutedSkills: parsed.mutedSkills ?? DEFAULT_CONFIG.mutedSkills,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: SkillfnConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function setPublishPrompts(value: PublishPrompts): Promise<void> {
  const config = await loadConfig();
  config.publishPrompts = value;
  await saveConfig(config);
}

export async function muteSkill(skillName: string): Promise<void> {
  const config = await loadConfig();
  if (!config.mutedSkills.includes(skillName)) {
    config.mutedSkills.push(skillName);
    await saveConfig(config);
  }
}

export async function isSkillMuted(skillName: string): Promise<boolean> {
  const config = await loadConfig();
  return config.mutedSkills.includes(skillName);
}

export { CONFIG_PATH };
