/**
 * SOUL.md — agent identity in yaaia folder. Appended to system prompt.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const YAAIA_DIR = join(homedir(), "yaaia");
const SOUL_PATH = join(YAAIA_DIR, "SOUL.md");

export function soulGet(): string {
  try {
    if (existsSync(SOUL_PATH)) {
      return readFileSync(SOUL_PATH, "utf-8").trim();
    }
  } catch (err) {
    console.warn("[YAAIA] Soul load failed:", err);
  }
  return "";
}

export function soulSet(content: string): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(SOUL_PATH, String(content ?? ""), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save SOUL.md:", err);
    throw err;
  }
}
