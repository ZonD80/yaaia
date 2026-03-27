/**
 * Message bus database — single source of truth.
 * messages: bus_id, role, text, received_at, during_eval, streaming_start, streaming_end
 * message_buses: bus_id, description, trust_level, is_banned, url
 */

import BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { kbEnsureCollection } from "./mcp-server/kb-client.js";
import { isTelegramConnected } from "./telegram-client.js";
import { isMailConnected } from "./mail-client.js";
import { isGoogleAuthorized } from "./google-auth.js";
import { getTrustLevelForBus, contactUpdateTrustByBusId } from "./contacts-store.js";
import { telegramDeleteChatHistory } from "./telegram-client.js";
import { mailDeleteMessagesByUids } from "./mail-client.js";
import { migrateMemorySchema } from "./memory-store.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const HISTORY_DB_PATH = join(YAAIA_DIR, "storage", "history.db");

export const ROOT_BUS_ID = "root";

let db: InstanceType<typeof BetterSqlite3> | null = null;

function getDb(): InstanceType<typeof BetterSqlite3> {
  if (!db) {
    const dir = join(YAAIA_DIR, "storage");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new BetterSqlite3(HISTORY_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_identifier TEXT NOT NULL,
        to_identifier TEXT NOT NULL,
        bus_id TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at TEXT NOT NULL,
        message_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        mail_uid INTEGER,
        event_uid TEXT,
        during_eval INTEGER NOT NULL DEFAULT 0,
        streaming_start TEXT,
        streaming_end TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_bus_id ON messages(bus_id);
      CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
      CREATE INDEX IF NOT EXISTS idx_messages_during_eval ON messages(during_eval);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_bus_message_id ON messages(bus_id, message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS message_buses (
        bus_id TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        trust_level TEXT NOT NULL DEFAULT 'normal' CHECK (trust_level IN ('normal', 'root')),
        is_banned INTEGER NOT NULL DEFAULT 0,
        url TEXT
      );
    `);
    migrateSchema();
    migrateMemorySchema(db);
  }
  return db;
}

/** Shared SQLite handle (messages + agent memory). */
export function getHistoryDb(): InstanceType<typeof BetterSqlite3> {
  return getDb();
}

/** Last persisted messages.id for a bus (before a new insert), for prev_msg_id headers. */
export function getLastMessageDbIdForBus(busId: string): number | undefined {
  const row = getDb()
    .prepare("SELECT id FROM messages WHERE bus_id = ? ORDER BY id DESC LIMIT 1")
    .get(busId) as { id: number } | undefined;
  return row?.id;
}

function migrateSchema(): void {
  const cols = getDb().prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("during_eval")) {
    getDb().exec("ALTER TABLE messages ADD COLUMN during_eval INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("streaming_start")) {
    getDb().exec("ALTER TABLE messages ADD COLUMN streaming_start TEXT");
  }
  if (!names.has("streaming_end")) {
    getDb().exec("ALTER TABLE messages ADD COLUMN streaming_end TEXT");
  }
}

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  /** SQLite messages.id — for model-facing history formatting only */
  db_id?: number;
  /** External/channel id from messages.message_id (not the SQLite row id). */
  external_message_id?: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  timestamp: string;
  mail_uid?: number;
  event_uid?: string;
  during_eval?: boolean;
  streaming_start?: string;
  streaming_end?: string;
};

export type BusMessage = {
  role: "user" | "assistant";
  content: string;
  db_id?: number;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  timestamp?: string;
  mail_uid?: number;
  event_uid?: string;
  message_id?: string;
  from_identifier?: string;
};

export type BusProperties = {
  bus_id: string;
  description: string;
  trust_level?: "normal" | "root";
  is_banned?: boolean;
  url?: string;
};

export type BusTrustLevel = "normal" | "root";

export type BusEntry = {
  bus_id: string;
  description: string;
  trust_level?: BusTrustLevel;
  is_banned?: boolean;
  is_connected: boolean;
};

export type RootLogForModel = { messages: BusMessage[]; trimmedCount: number };

export function isValidBusIdFormat(busId: string): boolean {
  if (!busId?.trim()) return false;
  if (busId === ROOT_BUS_ID) return true;
  if (/^telegram-\d+$/.test(busId)) return true;
  if (/^email-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  if (/^gmail-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  if (/^google-calendar-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  return false;
}

export function isValidBusId(busId: string): boolean {
  if (!busId?.trim()) return false;
  if (busId === ROOT_BUS_ID) return true;
  const buses = listBuses();
  if (buses.some((b) => b.bus_id === busId)) return true;
  if (/^telegram-\d+$/.test(busId)) return true;
  if (/^email-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  if (/^gmail-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  if (/^google-calendar-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  return false;
}

export function ensureHistoryCollection(): void {
  kbEnsureCollection("history");
}

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

export function isBusConnected(busId: string): boolean {
  if (busId === ROOT_BUS_ID) return true;
  if (busId.startsWith("telegram-")) return isTelegramConnected();
  if (busId.startsWith("email-")) return isMailConnected();
  if (busId.startsWith("gmail-") || busId.startsWith("google-calendar-")) return isGoogleAuthorized();
  return true;
}

export function loadBusProperties(mbId: string): BusProperties | null {
  const row = getDb().prepare("SELECT bus_id, description, trust_level, is_banned, url FROM message_buses WHERE bus_id = ?").get(mbId) as
    | { bus_id: string; description: string; trust_level: string; is_banned: number; url: string | null }
    | undefined;
  if (!row) return null;
  return {
    bus_id: row.bus_id,
    description: row.description ?? "",
    trust_level: row.trust_level === "root" ? "root" : "normal",
    is_banned: row.is_banned !== 0,
    url: row.url ?? undefined,
  };
}

export function saveBusProperties(props: BusProperties): void {
  const stmt = getDb().prepare(`
    INSERT INTO message_buses (bus_id, description, trust_level, is_banned, url)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bus_id) DO UPDATE SET
      description = excluded.description,
      trust_level = excluded.trust_level,
      is_banned = excluded.is_banned,
      url = excluded.url
  `);
  stmt.run(
    props.bus_id,
    props.description ?? "",
    props.trust_level ?? "normal",
    props.is_banned ? 1 : 0,
    props.url ?? null
  );
}

export function ensureMbDir(mbId: string, props?: Partial<BusProperties>): void {
  const existing = loadBusProperties(mbId);
  if (!existing) {
    saveBusProperties({
      bus_id: mbId,
      description: props?.description ?? "",
      trust_level: props?.trust_level ?? "normal",
      is_banned: props?.is_banned ?? false,
    });
  } else if (props && Object.keys(props).length > 0) {
    saveBusProperties({ ...existing, ...props });
  }
}

export function ensureBus(busId: string, description?: string): void {
  ensureRootBus();
  ensureMbDir(busId, description !== undefined ? { description } : undefined);
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
      is_connected: isBusConnected(busId),
    });
  }
  return out;
}

export function getBusDescription(busId: string): string {
  const props = loadBusProperties(busId);
  return props?.description ?? "";
}

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
    const updated = contactUpdateTrustByBusId(busId, props.trust_level);
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

function toFromIdentifier(msg: { role: string; user_id?: number; user_name?: string; from_identifier?: string }): string {
  if (msg.role === "assistant") return "assistant";
  return (msg as { from_identifier?: string }).from_identifier ?? msg.user_name ?? (msg.user_id != null ? String(msg.user_id) : "user");
}

export type AppendMessageOptions = {
  timestamp?: string;
  message_id?: string;
  during_eval?: boolean;
  streaming_start?: string;
  streaming_end?: string;
};

/** Result of inserting a message row. db_id is SQLite messages.id; external_message_id is the optional channel id column. */
export type AppendMessageResult = {
  db_id: number;
  external_message_id?: string;
};

export function appendMessage(
  busId: string,
  message: {
    role: "user" | "assistant";
    content: string;
    user_id?: number;
    user_name?: string;
    bus_id?: string;
    mail_uid?: number;
    event_uid?: string;
    from_identifier?: string;
  } & AppendMessageOptions
): AppendMessageResult {
  const receivedAt = message.timestamp ?? new Date().toISOString();
  const fromId = toFromIdentifier(message);
  const toId = message.bus_id ?? busId;
  const messageId =
    message.mail_uid != null
      ? String(message.mail_uid)
      : message.event_uid ?? message.message_id ?? undefined;

  const stmt = getDb().prepare(`
    INSERT INTO messages (from_identifier, to_identifier, bus_id, text, received_at, message_id, role, mail_uid, event_uid, during_eval, streaming_start, streaming_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const runResult = stmt.run(
    fromId,
    toId,
    message.bus_id ?? busId,
    message.content,
    receivedAt,
    messageId ?? null,
    message.role,
    message.mail_uid ?? null,
    message.event_uid ?? null,
    message.during_eval ? 1 : 0,
    message.streaming_start ?? null,
    message.streaming_end ?? null
  );
  const db_id = Number(runResult.lastInsertRowid);
  return {
    db_id,
    ...(messageId != null ? { external_message_id: messageId } : {}),
  };
}

/** Append message (alias for legacy). */
export function appendToHistory(
  busId: string,
  message: Omit<HistoryMessage, "timestamp"> & { timestamp?: string; message_id?: string }
): AppendMessageResult {
  return appendMessage(busId, {
    role: message.role,
    content: message.content,
    user_id: message.user_id,
    user_name: message.user_name,
    bus_id: message.bus_id ?? busId,
    timestamp: message.timestamp,
    mail_uid: message.mail_uid,
    event_uid: message.event_uid,
    message_id: (message as { message_id?: string }).message_id,
    from_identifier: (message as { from_identifier?: string }).from_identifier,
    during_eval: message.during_eval,
  });
}

/** Append a placeholder for streaming; returns messageId, streamingStart, and SQLite db_id. */
export function appendStreamingPlaceholder(busId: string): { messageId: string; streamingStart: string; db_id: number } {
  ensureRootBus();
  ensureMbDir(busId);
  const messageId = `${busId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const { db_id } = appendMessage(busId, {
    role: "assistant",
    content: "",
    bus_id: busId,
    message_id: messageId,
    from_identifier: "assistant",
    during_eval: false,
    streaming_start: now,
  });
  return { messageId, streamingStart: now, db_id };
}

/** Update message content by bus_id and message_id (streaming). */
export function updateMessageContent(busId: string, messageId: string, content: string): boolean {
  const stmt = getDb().prepare(
    "UPDATE messages SET text = ?, received_at = ? WHERE bus_id = ? AND message_id = ?"
  );
  const result = stmt.run(content, new Date().toISOString(), busId, messageId);
  return (result as { changes: number }).changes > 0;
}

/** Set streaming_end for a message. */
export function setStreamingEnd(busId: string, messageId: string): boolean {
  const stmt = getDb().prepare(
    "UPDATE messages SET streaming_end = ? WHERE bus_id = ? AND message_id = ?"
  );
  const result = stmt.run(new Date().toISOString(), busId, messageId);
  return (result as { changes: number }).changes > 0;
}

/** Replace message content by bus_id and message_id. */
export function replaceMessageByBusAndId(busId: string, messageId: string, content: string): boolean {
  return updateMessageContent(busId, messageId, content);
}

/** Get messages with during_eval=false in time window from any bus.
 *  roleFilter: when 'user', only return user messages (for detecting external input while agent was generating). */
export function getMessagesInWindow(
  fromTime: string,
  toTime: string,
  duringEval: boolean = false,
  roleFilter?: "user" | "assistant"
): HistoryMessage[] {
  const roleClause = roleFilter === "user" ? " AND role = 'user'" : roleFilter === "assistant" ? " AND role = 'assistant'" : "";
  const stmt = getDb().prepare(`
    SELECT id, from_identifier, bus_id, text, received_at, role, mail_uid, event_uid, message_id, during_eval, streaming_start, streaming_end
    FROM messages
    WHERE received_at >= ? AND received_at <= ? AND during_eval = ?${roleClause}
    ORDER BY received_at ASC
  `);
  const rows = stmt.all(fromTime, toTime, duringEval ? 1 : 0) as Array<{
    id: number;
    from_identifier: string;
    bus_id: string;
    text: string;
    received_at: string;
    role: string;
    mail_uid: number | null;
    event_uid: string | null;
    message_id: string | null;
    during_eval: number;
    streaming_start: string | null;
    streaming_end: string | null;
  }>;
  return rows.map(rowToHistoryMessage);
}

function rowToHistoryMessage(row: {
  id?: number;
  from_identifier: string;
  bus_id: string;
  text: string;
  received_at: string;
  role: string;
  mail_uid: number | null;
  event_uid: string | null;
  message_id?: string | null;
  during_eval?: number;
  streaming_start?: string | null;
  streaming_end?: string | null;
}): HistoryMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  const user_id = role === "user" && /^\d+$/.test(row.from_identifier) ? parseInt(row.from_identifier, 10) : undefined;
  const user_name = role === "user" && row.from_identifier !== "user" && !user_id ? row.from_identifier : undefined;
  const ext = row.message_id != null && String(row.message_id).trim() !== "" ? String(row.message_id) : undefined;
  return {
    role,
    content: row.text,
    ...(row.id != null ? { db_id: row.id } : {}),
    ...(ext ? { external_message_id: ext } : {}),
    user_id,
    user_name,
    bus_id: row.bus_id,
    timestamp: row.received_at,
    mail_uid: row.mail_uid ?? undefined,
    event_uid: row.event_uid ?? undefined,
    during_eval: row.during_eval === 1,
    streaming_start: row.streaming_start ?? undefined,
    streaming_end: row.streaming_end ?? undefined,
  };
}

function rowToBusMessage(row: {
  id?: number;
  from_identifier: string;
  bus_id: string;
  text: string;
  received_at: string;
  role: string;
  mail_uid: number | null;
  event_uid: string | null;
  message_id?: string | null;
}): BusMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  const user_id = role === "user" && /^\d+$/.test(row.from_identifier) ? parseInt(row.from_identifier, 10) : undefined;
  const user_name = role === "user" && row.from_identifier !== "user" && !user_id ? row.from_identifier : undefined;
  const ext = row.message_id != null && String(row.message_id).trim() !== "" ? String(row.message_id) : undefined;
  return {
    role,
    content: row.text,
    ...(row.id != null ? { db_id: row.id } : {}),
    user_id,
    user_name,
    bus_id: row.bus_id,
    timestamp: row.received_at,
    mail_uid: row.mail_uid ?? undefined,
    event_uid: row.event_uid ?? undefined,
    ...(ext ? { message_id: ext } : {}),
  };
}

export function toBusMessage(m: HistoryMessage): BusMessage {
  return {
    role: m.role,
    content: m.content,
    db_id: m.db_id,
    user_id: m.user_id,
    user_name: m.user_name,
    bus_id: m.bus_id,
    timestamp: m.timestamp,
    mail_uid: m.mail_uid,
    event_uid: m.event_uid,
    ...(m.external_message_id ? { message_id: m.external_message_id } : {}),
  };
}

export function getBusHistory(busId: string): HistoryMessage[] {
  const stmt = getDb().prepare(
    "SELECT id, from_identifier, bus_id, text, received_at, role, mail_uid, event_uid, message_id FROM messages WHERE bus_id = ? ORDER BY received_at ASC"
  );
  const rows = stmt.all(busId) as Parameters<typeof rowToHistoryMessage>[0][];
  return rows.map(rowToHistoryMessage);
}

/** Optional filters applied before offset/limit window (same semantics as unfiltered slice). */
export type BusHistorySliceFilter = {
  /** ISO-8601 — include messages with received_at >= this */
  from_timestamp?: string;
  /** ISO-8601 — include messages with received_at <= this */
  to_timestamp?: string;
  /** SQLite messages.id — include messages with id >= this (inclusive) */
  from_id?: number;
};

function applyBusHistorySliceFilter(full: HistoryMessage[], filter?: BusHistorySliceFilter): HistoryMessage[] {
  if (!filter) return full;
  const fromTs = filter.from_timestamp?.trim();
  const toTs = filter.to_timestamp?.trim();
  const fromId = filter.from_id;
  return full.filter((m) => {
    if (fromTs && m.timestamp < fromTs) return false;
    if (toTs && m.timestamp > toTs) return false;
    if (fromId != null && (m.db_id == null || m.db_id < fromId)) return false;
    return true;
  });
}

export function getBusHistorySlice(
  busId: string,
  limit: number = 50,
  offset: number = 0,
  filter?: BusHistorySliceFilter
): HistoryMessage[] {
  const raw = busId === ROOT_BUS_ID ? getRootLogFull() : getBusHistory(busId);
  const full = applyBusHistorySliceFilter(raw, filter);
  if (offset === 0) return full.slice(-limit);
  if (offset > 0) return full.slice(offset, offset + limit);
  const from = Math.max(0, full.length + offset);
  return full.slice(from, from + limit);
}

export function getActiveBuses(): string[] {
  const fromMessages = getDb().prepare("SELECT DISTINCT bus_id FROM messages").all() as { bus_id: string }[];
  const fromBuses = getDb().prepare("SELECT bus_id FROM message_buses").all() as { bus_id: string }[];
  const buses = new Set([...fromMessages.map((r) => r.bus_id), ...fromBuses.map((r) => r.bus_id)]);
  buses.add(ROOT_BUS_ID);
  return Array.from(buses).filter(isValidBusIdFormat);
}

export type RootLogResult = { messages: HistoryMessage[]; trimmedCount: number };

/** Character count for root-log cap (synthetic HISTORY / prior DB window). */
function historyContentChars(m: HistoryMessage): number {
  return m.content?.length ?? 0;
}

export function getRootLogFull(): HistoryMessage[] {
  const buses = getActiveBuses();
  const all: HistoryMessage[] = [];
  for (const busId of buses) {
    all.push(...getBusHistory(busId));
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

export function getRootLog(maxChars: number = 50_000): RootLogResult {
  const all = getRootLogFull();
  let total = 0;
  const result: HistoryMessage[] = [];
  for (const m of all) {
    total += historyContentChars(m);
    result.push(m);
  }
  // Cap by trimming from oldest (front), keep newest
  while (total > maxChars && result.length > 1) {
    const removed = result.shift()!;
    total -= historyContentChars(removed);
  }
  const trimmedCount = all.length - result.length;
  return { messages: result, trimmedCount };
}

const DEFAULT_ROOT_LOG_CHARS = 50_000;

export function getRootLogForModel(maxChars: number = DEFAULT_ROOT_LOG_CHARS): RootLogForModel {
  const { messages, trimmedCount } = getRootLog(maxChars);
  return { messages: messages.map(toBusMessage), trimmedCount };
}

export function getBusHistorySliceAsBusMessages(
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
  return getBusHistorySlice(busId, limit, offset).map(toBusMessage);
}

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

export function getRootBusHistoryOnly(): BusMessage[] {
  return getBusHistory(ROOT_BUS_ID).map(toBusMessage);
}

/** Returns SQLite messages.id for the new row. */
export function appendToBusHistory(busId: string, message: BusMessage): number {
  ensureRootBus();
  ensureMbDir(busId);
  const r = appendMessage(busId, {
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
  return r.db_id;
}

/** Append placeholder with generated message_id. Returns message_id for later replace. */
export function appendPlaceholderWithId(busId: string, role: "user" | "assistant" = "assistant"): string {
  ensureRootBus();
  ensureMbDir(busId);
  const messageId = `${busId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  appendMessage(busId, {
    role,
    content: "",
    bus_id: busId,
    message_id: messageId,
    from_identifier: role === "assistant" ? "assistant" : "user",
  });
  return messageId;
}

export function replaceBusMessage(busId: string, messageId: string, content: string): boolean {
  return replaceMessageByBusAndId(busId, messageId, content);
}

export function deleteBusHistory(busId: string): void {
  getDb().prepare("DELETE FROM messages WHERE bus_id = ?").run(busId);
  getDb().prepare("DELETE FROM message_buses WHERE bus_id = ?").run(busId);
}

export function wipeRootHistory(): void {
  deleteBusHistory(ROOT_BUS_ID);
}

/** Delete all messages from all buses. Keeps bus definitions. */
export function wipeAllHistory(): void {
  getDb().prepare("DELETE FROM messages").run();
}

export function hasMessageIdInBusHistory(busId: string, messageId: string): boolean {
  const stmt = getDb().prepare("SELECT 1 FROM messages WHERE bus_id = ? AND message_id = ? LIMIT 1");
  const row = stmt.get(busId, messageId);
  return !!row;
}

export function hasMailUidInBusHistory(busId: string, mailUid: number): boolean {
  const stmt = getDb().prepare("SELECT 1 FROM messages WHERE bus_id = ? AND mail_uid = ? LIMIT 1");
  const row = stmt.get(busId, mailUid);
  return !!row;
}

export function removeMessagesFromBusHistoryByMailUids(busId: string, uids: number[]): void {
  if (uids.length === 0) return;
  const stmt = getDb().prepare("DELETE FROM messages WHERE bus_id = ? AND mail_uid = ?");
  for (const uid of uids) stmt.run(busId, uid);
}

export function hasEventInBusHistory(busId: string, eventUid: string): boolean {
  if (eventUid.length === 0) return false;
  const stmt = getDb().prepare("SELECT 1 FROM messages WHERE bus_id = ? AND event_uid = ? LIMIT 1");
  const row = stmt.get(busId, eventUid);
  return !!row;
}

export function removeMessagesFromBusHistoryByEventUids(busId: string, eventUids: string[]): void {
  if (eventUids.length === 0) return;
  const placeholders = eventUids.map(() => "?").join(",");
  getDb().prepare(`DELETE FROM messages WHERE bus_id = ? AND event_uid IN (${placeholders})`).run(busId, ...eventUids);
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
    const history = getBusHistory(busId);
    const uids = history.map((m) => m.mail_uid).filter((u): u is number => typeof u === "number" && u > 0);
    if (uids.length > 0) {
      await mailDeleteMessagesByUids(uids);
    }
  }
  deleteBusHistory(busId);
}
