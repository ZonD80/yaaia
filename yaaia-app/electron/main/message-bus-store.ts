/**
 * Message bus store: all in kb/history/{mb_id}/
 * - properties: kb/history/{mb_id}/properties.md
 * - history: kb/history/{mb_id}/{date}/{seq}.md
 * Root bus (bus_id="root") always exists and cannot be deleted by agent.
 */

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
  loadBusProperties,
  saveBusProperties,
  ensureMbDir,
} from "./history-store.js";
import { isTelegramConnected, telegramDeleteChatHistory } from "./telegram-client.js";

export type RootLogForModel = { messages: BusMessage[]; trimmedCount: number };

export const ROOT_BUS_ID = "root";

export type BusMessage = {
  role: "user" | "assistant";
  content: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  /** ISO timestamp; when set, used for history file path (YYYY-MM-DD). Included in get_bus_history for ordering/display. */
  timestamp?: string;
};

export type BusTrustLevel = "normal" | "root";

export type BusEntry = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
  is_banned?: boolean;
};

function ensureRootBus(): void {
  const existing = loadBusProperties(ROOT_BUS_ID);
  if (!existing) {
    saveBusProperties({
      bus_id: ROOT_BUS_ID,
      description: "Desktop chat (root)",
      trust_level: "normal",
      is_banned: false,
    });
  }
}

export function listBuses(): BusEntry[] {
  ensureRootBus();
  const buses = getActiveBuses();
  const out: BusEntry[] = [];
  for (const busId of buses) {
    const props = loadBusProperties(busId);
    out.push({
      bus_id: busId,
      description: props?.description ?? "",
      trust_level: (props?.trust_level as BusTrustLevel) ?? "normal",
      is_banned: props?.is_banned ?? false,
    });
  }
  return out;
}

export function getBusDescription(busId: string): string {
  const props = loadBusProperties(busId);
  return props?.description ?? "";
}

export function getBusTrustLevel(busId: string): BusTrustLevel {
  const props = loadBusProperties(busId);
  return props?.trust_level === "root" ? "root" : "normal";
}

export function isBusBanned(busId: string): boolean {
  if (busId === ROOT_BUS_ID) return false;
  const props = loadBusProperties(busId);
  return Boolean(props?.is_banned);
}

export function setBusProperties(
  busId: string,
  props: { description?: string; trust_level?: BusTrustLevel; is_banned?: boolean }
): void {
  ensureRootBus();
  const existing = loadBusProperties(busId) ?? {
    bus_id: busId,
    description: "",
    trust_level: "normal" as const,
    is_banned: false,
  };
  if (props.description !== undefined) existing.description = props.description;
  if (props.trust_level !== undefined) existing.trust_level = props.trust_level;
  if (props.is_banned !== undefined) {
    if (busId === ROOT_BUS_ID) throw new Error("Root bus cannot be banned");
    existing.is_banned = props.is_banned;
  }
  saveBusProperties(existing);
}

export function ensureBus(busId: string, description?: string): void {
  ensureRootBus();
  ensureMbDir(busId, description !== undefined ? { description } : undefined);
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
  ensureMbDir(busId);
  appendToHistory(busId, {
    role: message.role,
    content: message.content,
    user_id: message.user_id,
    user_name: message.user_name,
    bus_id: message.bus_id ?? busId,
    timestamp: message.timestamp,
  });
}
