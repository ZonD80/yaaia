/**
 * CalDAV event UID → scheduled task ID mapping.
 * Used to avoid creating duplicate tasks for the same event and to sync on app start.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const YAAIA_DIR = join(homedir(), "yaaia");
const CALDAV_EVENT_TASKS_PATH = join(YAAIA_DIR, "caldav-event-tasks.json");

type EventTasksFile = {
  v?: number;
  /** event_uid (from ics) -> task_id (from schedule-store) */
  mapping: Record<string, string>;
};

function loadFile(): EventTasksFile {
  try {
    if (existsSync(CALDAV_EVENT_TASKS_PATH)) {
      const raw = JSON.parse(readFileSync(CALDAV_EVENT_TASKS_PATH, "utf-8"));
      return {
        v: 1,
        mapping: typeof raw?.mapping === "object" ? raw.mapping : {},
      };
    }
  } catch (err) {
    console.warn("[YAAIA CalDAV] Failed to load event tasks:", err);
  }
  return { v: 1, mapping: {} };
}

function saveFile(data: EventTasksFile): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(CALDAV_EVENT_TASKS_PATH, JSON.stringify({ v: 1, ...data }, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA CalDAV] Failed to save event tasks:", err);
  }
}

/** Get task_id for an event UID, or undefined if none. */
export function getTaskIdForEventUid(eventUid: string): string | undefined {
  return loadFile().mapping[eventUid];
}

/** Set event UID → task_id mapping. */
export function setEventTaskMapping(eventUid: string, taskId: string): void {
  const file = loadFile();
  file.mapping[eventUid] = taskId;
  saveFile(file);
}

/** Remove mapping for an event UID, e.g. when task was deleted. */
export function removeEventTaskMapping(eventUid: string): void {
  const file = loadFile();
  delete file.mapping[eventUid];
  saveFile(file);
}

/** Check if we already have a task for this event. */
export function hasTaskForEventUid(eventUid: string): boolean {
  return getTaskIdForEventUid(eventUid) !== undefined;
}
