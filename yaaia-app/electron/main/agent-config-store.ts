import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const YAAIA_DIR = join(homedir(), "yaaia");
const AGENT_CONFIG_PATH = join(YAAIA_DIR, "agent-config.json");

export type AgentConfigEntry = {
  id: string;
  detailed_description: string;
  value: string;
};

type ConfigFile = {
  v?: number;
  items: AgentConfigEntry[];
};

function loadAgentConfig(): AgentConfigEntry[] {
  try {
    if (existsSync(AGENT_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(AGENT_CONFIG_PATH, "utf-8"));
      if (raw?.items && Array.isArray(raw.items)) {
        return raw.items;
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const items: AgentConfigEntry[] = [];
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string") {
            items.push({
              id: randomUUID(),
              detailed_description: k,
              value: v,
            });
          }
        }
        if (items.length > 0) {
          saveAgentConfig(items);
          return items;
        }
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Agent config load failed:", err);
  }
  return [];
}

function saveAgentConfig(items: AgentConfigEntry[]): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(AGENT_CONFIG_PATH, JSON.stringify({ v: 2, items }, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save agent config:", err);
  }
}

export function validateDetailedDescription(description: string): void {
  if (description.includes(",")) {
    throw new Error("Detailed description must not contain commas");
  }
}

export function agentConfigList(): AgentConfigEntry[] {
  return loadAgentConfig();
}

export function agentConfigSet(detailed_description: string, value: string, force: boolean): string {
  validateDetailedDescription(detailed_description);
  const items = loadAgentConfig();
  const existing = items.find((e) => e.detailed_description === detailed_description);
  if (existing && !force) {
    throw new Error(`Config "${detailed_description}" already exists. Use force=true to overwrite.`);
  }
  const entry: AgentConfigEntry = {
    id: existing?.id ?? randomUUID(),
    detailed_description,
    value,
  };
  const rest = items.filter((e) => e.id !== entry.id);
  saveAgentConfig([...rest, entry]);
  return entry.id;
}

export function agentConfigDelete(id: string): void {
  const items = loadAgentConfig().filter((e) => e.id !== id);
  saveAgentConfig(items);
}

export function agentConfigWipe(): void {
  saveAgentConfig([]);
}
