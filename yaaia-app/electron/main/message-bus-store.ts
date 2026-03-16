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
import { isMailConnected, mailDeleteMessagesByUids } from "./mail-client.js";
import { isCaldavConnected } from "./caldav-client.js";
import { getTrustLevelForBus, identityUpdateTrustByBusId } from "./identities-store.js";

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
  /** IMAP UID for email bus cleanup (delete from mailbox) */
  mail_uid?: number;
  /** CalDAV event UID for calendar event cleanup (delete from history when event deleted) */
  event_uid?: string;
  /** Telegram message ID for database duplicate check */
  message_id?: string;
  /** Explicit from_identifier for root (config.rootUserIdentifier or identity). User = identifier, assistant = "assistant". */
  from_identifier?: string;
};

export type BusTrustLevel = "normal" | "root";

export type BusEntry = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
  is_banned?: boolean;
  is_connected: boolean;
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

function getBusConnected(busId: string): boolean {
  if (busId === ROOT_BUS_ID) return true;
  if (busId.startsWith("telegram-")) return isTelegramConnected();
  if (busId.startsWith("email-")) return isMailConnected();
  if (busId.startsWith("caldav-")) return isCaldavConnected();
  return true;
}

export function listBuses(): BusEntry[] {
  ensureRootBus();
  const buses = getActiveBuses();
  const out: BusEntry[] = [];
  for (const busId of buses) {
    const props = loadBusProperties(busId);
    const trustLevel = getTrustLevelForBus(busId);
    out.push({
      bus_id: busId,
      description: props?.description ?? "",
      trust_level: trustLevel,
      is_banned: props?.is_banned ?? false,
      is_connected: getBusConnected(busId),
    });
  }
  return out;
}

export function getBusDescription(busId: string): string {
  const props = loadBusProperties(busId);
  return props?.description ?? "";
}

/** Trust from identity. For email, pass senderEmail to resolve per-sender identity. */
export function getBusTrustLevel(busId: string, senderEmail?: string): BusTrustLevel {
  return getTrustLevelForBus(busId, senderEmail);
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
  if (props.trust_level !== undefined) {
    const updated = identityUpdateTrustByBusId(busId, props.trust_level);
    if (!updated) {
      existing.trust_level = props.trust_level;
    }
  }
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
  if (busId.startsWith("email-")) {
    if (!isMailConnected()) {
      throw new Error("Mail not connected. Connect mail before deleting an email bus.");
    }
    const history = getHistory(busId);
    const uids = history.map((m) => m.mail_uid).filter((u): u is number => typeof u === "number" && u > 0);
    if (uids.length > 0) {
      await mailDeleteMessagesByUids(uids);
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

const DEFAULT_ROOT_LOG_CHARS = 50_000;
const LLM_HISTORY_MESSAGE_LIMIT = 30;

/** Root log for model: messages + trimmedCount. Use when building context for the model. */
export function getRootLogForModel(maxChars: number = DEFAULT_ROOT_LOG_CHARS): RootLogForModel {
  const { messages, trimmedCount } = getRootLog(maxChars);
  return { messages: messages.map(toBusMessage), trimmedCount };
}

/** Last N messages from merged root log for LLM context. No Mem0; uses database history only. */
export function getRootLogForModelWithMessageLimit(limit: number = LLM_HISTORY_MESSAGE_LIMIT): RootLogForModel {
  const full = getRootLogFull().map(toBusMessage);
  const messages = full.slice(-limit);
  return { messages, trimmedCount: Math.max(0, full.length - limit) };
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

/** Root history slice with total count for pagination. offset=0 returns last `limit` messages. */
export function getRootHistorySliceWithTotal(
  limit: number,
  offset: number
): { messages: BusMessage[]; total: number } {
  const { messages } = getRootLog(50_000);
  const total = messages.length;
  if (offset === 0) {
    return { messages: messages.slice(-limit).map(toBusMessage), total };
  }
  const from = Math.max(0, offset - 1);
  return { messages: messages.slice(from, from + limit).map(toBusMessage), total };
}

/** Get root bus history only (not merged). Useful for duplicate checks. */
export function getRootBusHistoryOnly(): BusMessage[] {
  return getHistory(ROOT_BUS_ID).map(toBusMessage);
}

let _isRootUserIdentifierDefined: () => boolean = () => true;

/** Inject check for root user identifier. When false, root chat history is not saved. */
export function setRootUserIdentifierDefinedCheck(fn: () => boolean): void {
  _isRootUserIdentifierDefined = fn;
}

export function appendToBusHistory(busId: string, message: BusMessage): void {
  if (busId === ROOT_BUS_ID && !_isRootUserIdentifierDefined()) return;
  ensureRootBus();
  ensureMbDir(busId);
  appendToHistory(busId, {
    role: message.role,
    content: message.content,
    user_id: message.user_id,
    user_name: message.user_name,
    bus_id: message.bus_id ?? busId,
    timestamp: message.timestamp,
    mail_uid: message.mail_uid,
    event_uid: message.event_uid,
    message_id: message.message_id,
    from_identifier: message.from_identifier,
  });
}
