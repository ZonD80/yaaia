/**
 * Message bus store: buses with descriptions and per-bus history.
 * Each bus saved to yaaia/mb/{bus_id}.json
 * Root bus (bus_id="root") always exists and cannot be deleted by agent.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";

export const ROOT_BUS_ID = "root";

const YAAIA_DIR = join(homedir(), "yaaia");
const MB_DIR = join(YAAIA_DIR, "mb");
const LEGACY_PATH = join(YAAIA_DIR, "agentData", "message-buses.json");

export type BusMessage = {
  role: "user" | "assistant";
  content: string;
  /** For user messages: user_id, user_name from the bus */
  user_id?: number;
  user_name?: string;
  /** bus_id when message is from a non-root bus (e.g. telegram-123) */
  bus_id?: string;
};

export type BusTrustLevel = "normal" | "root";

export type BusEntry = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
};

type BusFile = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
  messages: BusMessage[];
};

/** Sanitize bus_id for use as filename (replace / and \ with safe chars) */
function busIdToFilename(busId: string): string {
  return busId.replace(/\//g, "__f__").replace(/\\/g, "__b__") + ".json";
}

function filenameToBusId(filename: string): string {
  return filename.slice(0, -5).replace(/__f__/g, "/").replace(/__b__/g, "\\");
}

function getBusFilePath(busId: string): string {
  return join(MB_DIR, busIdToFilename(busId));
}

function loadBusFile(busId: string): BusFile | null {
  const path = getBusFilePath(busId);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      if (raw && typeof raw.bus_id === "string") {
        return {
          bus_id: raw.bus_id,
          description: String(raw.description ?? ""),
          trust_level: raw.trust_level === "root" ? "root" : "normal",
          messages: Array.isArray(raw.messages) ? raw.messages : [],
        };
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Message bus load failed:", busId, err);
  }
  return null;
}

function saveBusFile(data: BusFile): void {
  mkdirSync(MB_DIR, { recursive: true });
  const path = getBusFilePath(data.bus_id);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function migrateFromLegacy(): void {
  try {
    if (!existsSync(LEGACY_PATH)) return;
    const raw = JSON.parse(readFileSync(LEGACY_PATH, "utf-8"));
    const buses: Array<{ bus_id: string; description: string }> = raw?.buses ?? [];
    const history: Record<string, BusMessage[]> = raw?.history ?? {};
    mkdirSync(MB_DIR, { recursive: true });
    for (const b of buses) {
      const messages = history[b.bus_id] ?? [];
      saveBusFile({ bus_id: b.bus_id, description: b.description, trust_level: "normal", messages });
    }
    unlinkSync(LEGACY_PATH);
    console.log("[YAAIA] Migrated message buses to mb/");
  } catch (err) {
    console.warn("[YAAIA] Legacy migration failed:", err);
  }
}

function ensureRootBus(): void {
  const existing = loadBusFile(ROOT_BUS_ID);
  if (!existing) {
    saveBusFile({
      bus_id: ROOT_BUS_ID,
      description: "Desktop chat (root)",
      trust_level: "normal",
      messages: [],
    });
  }
}

export function listBuses(): BusEntry[] {
  migrateFromLegacy();
  ensureRootBus();
  const out: BusEntry[] = [];
  try {
    if (!existsSync(MB_DIR)) return out;
    const files = readdirSync(MB_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const busId = filenameToBusId(f);
      const data = loadBusFile(busId);
      if (data) {
        out.push({
          bus_id: data.bus_id,
          description: data.description,
          trust_level: data.trust_level ?? "normal",
        });
      }
    }
  } catch (err) {
    console.warn("[YAAIA] listBuses failed:", err);
  }
  return out;
}

export function getBusDescription(busId: string): string {
  const data = loadBusFile(busId);
  return data?.description ?? "";
}

export function getBusTrustLevel(busId: string): BusTrustLevel {
  const data = loadBusFile(busId);
  return data?.trust_level === "root" ? "root" : "normal";
}

export function setBusProperties(
  busId: string,
  props: { description?: string; trust_level?: BusTrustLevel }
): void {
  ensureRootBus();
  const data = loadBusFile(busId) ?? {
    bus_id: busId,
    description: "",
    trust_level: "normal" as BusTrustLevel,
    messages: [],
  };
  data.bus_id = busId;
  if (props.description !== undefined) data.description = props.description;
  if (props.trust_level !== undefined) data.trust_level = props.trust_level;
  saveBusFile(data);
}

export function ensureBus(busId: string, description?: string): void {
  ensureRootBus();
  const data = loadBusFile(busId);
  if (!data) {
    saveBusFile({
      bus_id: busId,
      description: description ?? "",
      trust_level: "normal",
      messages: [],
    });
  } else if (description !== undefined) {
    data.description = description;
    saveBusFile(data);
  }
}

export function deleteBus(busId: string): void {
  if (busId === ROOT_BUS_ID) {
    throw new Error("Root bus cannot be deleted");
  }
  const path = getBusFilePath(busId);
  if (existsSync(path)) unlinkSync(path);
}

export function wipeRootHistory(): void {
  const data = loadBusFile(ROOT_BUS_ID);
  if (data) {
    data.messages = [];
    saveBusFile(data);
  }
}

export function getBusHistory(busId: string): BusMessage[] {
  const data = loadBusFile(busId);
  return data?.messages ?? [];
}

/** Get a slice of bus history. offset=0, limit=N = last N (default). offset>0 = from start. offset<0 = from end. */
export function getBusHistorySlice(
  busId: string,
  limit: number = 50,
  offset: number = 0
): BusMessage[] {
  const full = getBusHistory(busId);
  if (offset === 0) {
    return full.slice(-limit);
  }
  if (offset > 0) {
    return full.slice(offset, offset + limit);
  }
  const from = Math.max(0, full.length + offset);
  return full.slice(from, from + limit);
}

export function appendToBusHistory(busId: string, message: BusMessage): void {
  ensureRootBus();
  const data = loadBusFile(busId) ?? {
    bus_id: busId,
    description: "",
    trust_level: "normal" as BusTrustLevel,
    messages: [],
  };
  data.bus_id = busId;
  data.messages.push(message);
  saveBusFile(data);
}
