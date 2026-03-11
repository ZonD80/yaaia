/**
 * Schedule store: one-time scheduled tasks.
 * Stored in ~/yaaia/schedules.json
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const YAAIA_DIR = join(homedir(), "yaaia");
const SCHEDULES_PATH = join(YAAIA_DIR, "schedules.json");

export type ScheduleEntry = {
  id: string;
  at: string; // RFC 3339
  title: string;
  instructions: string;
  created_at: string; // RFC 3339
};

export const DEFAULT_STARTUP_TASK = {
  title: "On duty",
  instructions: "Get my identity, connect to telegram, check new mail, report to user that i'm on duty. If any scheduled tasks were due while the app was closed, resume and complete them first.",
};

export type StartupTask = { title: string; instructions: string };

type SchedulesFile = {
  v?: number;
  items: ScheduleEntry[];
  startup_task?: StartupTask;
};

function loadFile(): SchedulesFile {
  try {
    if (existsSync(SCHEDULES_PATH)) {
      const raw = JSON.parse(readFileSync(SCHEDULES_PATH, "utf-8"));
      return {
        items: Array.isArray(raw?.items) ? raw.items : [],
        startup_task: raw?.startup_task ?? DEFAULT_STARTUP_TASK,
      };
    }
  } catch (err) {
    console.warn("[YAAIA] Schedules load failed:", err);
  }
  return { items: [], startup_task: DEFAULT_STARTUP_TASK };
}

function loadSchedules(): ScheduleEntry[] {
  return loadFile().items;
}

function saveFile(data: SchedulesFile): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(SCHEDULES_PATH, JSON.stringify({ v: 1, ...data }, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save schedules:", err);
  }
}

function saveSchedules(items: ScheduleEntry[]): void {
  saveFile({ ...loadFile(), items });
}

export function getStartupTask(): StartupTask {
  const file = loadFile();
  return file.startup_task ?? DEFAULT_STARTUP_TASK;
}

export function setStartupTask(task: StartupTask): void {
  const file = loadFile();
  file.startup_task = task;
  saveFile(file);
}

export function listSchedules(): ScheduleEntry[] {
  return loadSchedules();
}

export function addSchedule(at: string, title: string, instructions: string): ScheduleEntry {
  const items = loadSchedules();
  const entry: ScheduleEntry = {
    id: randomUUID(),
    at,
    title,
    instructions,
    created_at: new Date().toISOString(),
  };
  items.push(entry);
  saveSchedules(items);
  return entry;
}

export function updateSchedule(
  id: string,
  props: { at?: string; title?: string; instructions?: string }
): ScheduleEntry | null {
  const items = loadSchedules();
  const idx = items.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  if (props.at !== undefined) items[idx].at = props.at;
  if (props.title !== undefined) items[idx].title = props.title;
  if (props.instructions !== undefined) items[idx].instructions = props.instructions;
  saveSchedules(items);
  return items[idx];
}

export function deleteSchedule(id: string): boolean {
  const items = loadSchedules().filter((s) => s.id !== id);
  if (items.length === loadSchedules().length) return false;
  saveSchedules(items);
  return true;
}

export function deleteSchedules(ids: string[]): void {
  const idSet = new Set(ids);
  const items = loadSchedules().filter((s) => !idSet.has(s.id));
  saveSchedules(items);
}

/** Get schedules due at or before now, sorted by at (oldest first) */
export function getDueSchedules(): ScheduleEntry[] {
  const now = new Date().toISOString();
  return loadSchedules()
    .filter((s) => s.at <= now)
    .sort((a, b) => a.at.localeCompare(b.at));
}
