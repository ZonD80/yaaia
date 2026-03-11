/**
 * Message bus store: bus metadata in yaaia/mb/{bus_id}.json,
 * message history in kb/history/YYYY-MM-DD/{bus_id}/{seq}.md
 * Root bus (bus_id="root") always exists and cannot be deleted by agent.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import {
  appendToHistory,
  deleteBusHistory,
  getActiveBuses,
  getBusHistory as getHistory,
  getBusHistorySlice as getHistorySlice,
  getRootLog,
  getRootLogFull,
  toBusMessage,
  wipeRootHistory as wipeHistory,
} from "./history-store.js";
import { isTelegramConnected, telegramDeleteChatHistory } from "./telegram-client.js";

export type RootLogForModel = { messages: BusMessage[]; trimmedCount: number };

export const ROOT_BUS_ID = "root";

const YAAIA_DIR = join(homedir(), "yaaia");
const MB_DIR = join(YAAIA_DIR, "mb");
const LEGACY_PATH = join(YAAIA_DIR, "agentData", "message-buses.json");

export type BusMessage = {
  role: "user" | "assistant";
  content: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  /** ISO timestamp; when set, used for history file path (YYYY-MM-DD) */
  timestamp?: string;
};

export type BusTrustLevel = "normal" | "root";

export type BusEntry = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
  is_banned?: boolean;
};

type BusMeta = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
  is_banned?: boolean;
};

function busIdToFilename(busId: string): string {
  return busId.replace(/\//g, "__f__").replace(/\\/g, "__b__") + ".json";
}

function filenameToBusId(filename: string): string {
  return filename.slice(0, -5).replace(/__f__/g, "/").replace(/__b__/g, "\\");
}

function getBusFilePath(busId: string): string {
  return join(MB_DIR, busIdToFilename(busId));
}

function loadBusMeta(busId: string): BusMeta | null {
  const path = getBusFilePath(busId);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      if (raw && typeof raw.bus_id === "string") {
        return {
          bus_id: raw.bus_id,
          description: String(raw.description ?? ""),
          trust_level: raw.trust_level === "root" ? "root" : "normal",
          is_banned: Boolean(raw.is_banned),
        };
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Message bus load failed:", busId, err);
  }
  return null;
}

function saveBusMeta(data: BusMeta): void {
  mkdirSync(MB_DIR, { recursive: true });
  writeFileSync(getBusFilePath(data.bus_id), JSON.stringify(data, null, 2), "utf-8");
}

function migrateFromLegacy(): void {
  try {
    if (!existsSync(LEGACY_PATH)) return;
    const raw = JSON.parse(readFileSync(LEGACY_PATH, "utf-8"));
    const buses: Array<{ bus_id: string; description: string }> = raw?.buses ?? [];
    mkdirSync(MB_DIR, { recursive: true });
    for (const b of buses) {
      saveBusMeta({
        bus_id: b.bus_id,
        description: b.description,
        trust_level: "normal",
      });
    }
    unlinkSync(LEGACY_PATH);
    console.log("[YAAIA] Migrated message buses to mb/");
  } catch (err) {
    console.warn("[YAAIA] Legacy migration failed:", err);
  }
}

function ensureRootBus(): void {
  const existing = loadBusMeta(ROOT_BUS_ID);
  if (!existing) {
    saveBusMeta({
      bus_id: ROOT_BUS_ID,
      description: "Desktop chat (root)",
      trust_level: "normal",
    });
  }
}

export function listBuses(): BusEntry[] {
  migrateFromLegacy();
  ensureRootBus();
  const seen = new Set<string>();
  const out: BusEntry[] = [];
  try {
    if (existsSync(MB_DIR)) {
      const files = readdirSync(MB_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const busId = filenameToBusId(f);
        const data = loadBusMeta(busId);
        if (data) {
          seen.add(busId);
          out.push({
            bus_id: data.bus_id,
            description: data.description,
            trust_level: data.trust_level ?? "normal",
            is_banned: data.is_banned ?? false,
          });
        }
      }
    }
    for (const busId of getActiveBuses()) {
      if (!seen.has(busId)) {
        seen.add(busId);
        out.push({ bus_id: busId, description: "", trust_level: "normal", is_banned: false });
      }
    }
  } catch (err) {
    console.warn("[YAAIA] listBuses failed:", err);
  }
  return out;
}

export function getBusDescription(busId: string): string {
  const data = loadBusMeta(busId);
  return data?.description ?? "";
}

export function getBusTrustLevel(busId: string): BusTrustLevel {
  const data = loadBusMeta(busId);
  return data?.trust_level === "root" ? "root" : "normal";
}

export function isBusBanned(busId: string): boolean {
  if (busId === ROOT_BUS_ID) return false;
  const data = loadBusMeta(busId);
  return Boolean(data?.is_banned);
}

export function setBusProperties(
  busId: string,
  props: { description?: string; trust_level?: BusTrustLevel; is_banned?: boolean }
): void {
  ensureRootBus();
  const data = loadBusMeta(busId) ?? {
    bus_id: busId,
    description: "",
    trust_level: "normal" as BusTrustLevel,
  };
  data.bus_id = busId;
  if (props.description !== undefined) data.description = props.description;
  if (props.trust_level !== undefined) data.trust_level = props.trust_level;
  if (props.is_banned !== undefined) {
    if (busId === ROOT_BUS_ID) throw new Error("Root bus cannot be banned");
    data.is_banned = props.is_banned;
  }
  saveBusMeta(data);
}

export function ensureBus(busId: string, description?: string): void {
  ensureRootBus();
  const data = loadBusMeta(busId);
  if (!data) {
    saveBusMeta({
      bus_id: busId,
      description: description ?? "",
      trust_level: "normal",
    });
  } else if (description !== undefined) {
    data.description = description;
    saveBusMeta(data);
  }
}

export async function deleteBus(busId: string): Promise<void> {
  if (busId === ROOT_BUS_ID) {
    throw new Error("Root bus cannot be deleted");
  }
  if (busId.startsWith("telegram-")) {
    if (!isTelegramConnected()) {
      throw new Error("Telegram not connected. Connect Telegram before deleting a Telegram bus.");
    }
    const peerId = parseInt(busId.replace("telegram-", ""), 10);
    if (!isNaN(peerId)) {
      await telegramDeleteChatHistory(peerId);
    }
  }
  deleteBusHistory(busId);
  const path = getBusFilePath(busId);
  if (existsSync(path)) unlinkSync(path);
}

export function wipeRootHistory(): void {
  wipeHistory();
}

/** Root log: merged from all active buses, trimmed to 50K. Use this for model context. */
export function getBusHistory(busId: string): BusMessage[] {
  if (busId === ROOT_BUS_ID) {
    return getRootLog(50_000).messages.map(toBusMessage);
  }
  return getHistory(busId).map(toBusMessage);
}

/** Root log for model: messages + trimmedCount. Use when building context for the model. */
export function getRootLogForModel(): RootLogForModel {
  const { messages, trimmedCount } = getRootLog(50_000);
  return { messages: messages.map(toBusMessage), trimmedCount };
}

export function getBusHistorySlice(
  busId: string,
  limit: number = 50,
  offset: number = 0
): BusMessage[] {
  if (busId === ROOT_BUS_ID) {
    if (offset === 0) {
      const { messages } = getRootLog(50_000);
      return messages.slice(-limit).map(toBusMessage);
    }
    const full = getRootLogFull().map(toBusMessage);
    if (offset > 0) {
      const from = Math.max(0, offset - 1);
      return full.slice(from, from + limit);
    }
    const from = Math.max(0, full.length + offset);
    return full.slice(from, from + limit);
  }
  return getHistorySlice(busId, limit, offset).map(toBusMessage);
}

export function appendToBusHistory(busId: string, message: BusMessage): void {
  ensureRootBus();
  appendToHistory(busId, {
    role: message.role,
    content: message.content,
    user_id: message.user_id,
    user_name: message.user_name,
    bus_id: message.bus_id ?? busId,
    timestamp: message.timestamp,
  });
}
