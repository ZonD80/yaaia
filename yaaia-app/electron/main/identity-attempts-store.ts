/**
 * Persisted count of unanswered "create identity" prompts per bus.
 * After 2-3 attempts, bus gets banned.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const YAAIA_DIR = join(homedir(), "yaaia");
const ATTEMPTS_PATH = join(YAAIA_DIR, "identity-attempts.json");

const MAX_ATTEMPTS = 3;

type AttemptsFile = {
  v?: number;
  by_bus: Record<string, number>;
};

function load(): AttemptsFile {
  try {
    if (existsSync(ATTEMPTS_PATH)) {
      const raw = JSON.parse(readFileSync(ATTEMPTS_PATH, "utf-8"));
      if (raw?.by_bus && typeof raw.by_bus === "object") {
        return { v: 1, by_bus: raw.by_bus };
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Identity attempts load failed:", err);
  }
  return { v: 1, by_bus: {} };
}

function save(data: AttemptsFile): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(ATTEMPTS_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save identity attempts:", err);
  }
}

export function getIdentityAttempts(busId: string): number {
  return load().by_bus[busId] ?? 0;
}

export function incrementIdentityAttempts(busId: string): number {
  const data = load();
  const count = (data.by_bus[busId] ?? 0) + 1;
  data.by_bus[busId] = count;
  save(data);
  return count;
}

export function resetIdentityAttempts(busId: string): void {
  const data = load();
  delete data.by_bus[busId];
  save(data);
}

export function shouldBanBusForNoIdentity(busId: string): boolean {
  return getIdentityAttempts(busId) >= MAX_ATTEMPTS;
}
