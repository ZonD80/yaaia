/**
 * Message bus history stored in SQLite.
 * Schema: from_identifier, to_identifier, bus_id, text, received_at(utc), message_id
 * Bus properties remain in kb/history/{mb_id}/properties.md
 */

import BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { kbList, kbRead, kbWrite, kbDelete, kbEnsureCollection } from "./mcp-server/kb-client.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const HISTORY_DB_PATH = join(YAAIA_DIR, "storage", "history.db");

const HISTORY_BASE = "history";
const PROPERTIES_FILE = "properties.md";

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
        event_uid TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_bus_id ON messages(bus_id);
      CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_bus_message_id ON messages(bus_id, message_id) WHERE message_id IS NOT NULL;
    `);
  }
  return db;
}

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  timestamp: string;
  mail_uid?: number;
  event_uid?: string;
};

export type BusProperties = {
  bus_id: string;
  description: string;
  trust_level?: "normal" | "root";
  is_banned?: boolean;
  url?: string;
};

/** Sanitize bus_id for use in path (replace / and \ with safe chars) */
function busIdToPathSegment(busId: string): string {
  return busId.replace(/\//g, "__f__").replace(/\\/g, "__b__");
}

function pathSegmentToBusId(segment: string): string {
  return segment.replace(/__f__/g, "/").replace(/__b__/g, "\\");
}

/** Check if bus_id matches expected format (root, telegram-*, email-*, caldav-*). Used to filter bogus buses from UI. */
export function isValidBusIdFormat(busId: string): boolean {
  if (!busId?.trim()) return false;
  if (busId === "root") return true;
  if (/^telegram-\d+$/.test(busId)) return true;
  if (/^email-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  if (/^caldav-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  return false;
}

/** Parse simple YAML block (key: value lines only) */
function parseYamlBlock(block: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) {
      const [, key, val] = m;
      let trimmed = val.trim();
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        trimmed = trimmed.slice(1, -1).replace(/\\"/g, '"');
      }
      if ((key === "user_id" || key === "mail_uid") && /^\d+$/.test(trimmed)) {
        out[key] = parseInt(trimmed, 10);
      } else {
        out[key] = trimmed;
      }
    }
  }
  return out;
}

/** Path to mb dir: history/{mb_id} */
function mbDirPath(mbId: string): string {
  return `${HISTORY_BASE}/${busIdToPathSegment(mbId)}`;
}

/** Path to properties: history/{mb_id}/properties.md */
function propertiesPath(mbId: string): string {
  return `${mbDirPath(mbId)}/${PROPERTIES_FILE}`;
}

/** Ensure history collection directory exists. */
export function ensureHistoryCollection(): void {
  kbEnsureCollection("history");
}

/** Load bus properties from history/{mb_id}/properties.md */
export function loadBusProperties(mbId: string): BusProperties | null {
  const path = propertiesPath(mbId);
  try {
    const content = kbRead(path);
    const meta = parseYamlBlock(content.split("---")[1]?.trim() ?? "");
    if (meta.bus_id) {
      return {
        bus_id: String(meta.bus_id),
        description: String(meta.description ?? ""),
        trust_level: meta.trust_level === "root" ? "root" : "normal",
        is_banned: String(meta.is_banned ?? "") === "true",
        url: meta.url ? String(meta.url) : undefined,
      };
    }
  } catch {
    /* no properties */
  }
  return null;
}

/** Save bus properties to history/{mb_id}/properties.md */
export function saveBusProperties(props: BusProperties): void {
  const path = propertiesPath(props.bus_id);
  const desc = (props.description ?? "").replace(/"/g, '\\"');
  const lines = [
    "---",
    `bus_id: ${props.bus_id}`,
    `description: "${desc}"`,
    `trust_level: ${props.trust_level ?? "normal"}`,
    `is_banned: ${props.is_banned ?? false}`,
    ...(props.url ? [`url: "${props.url.replace(/"/g, '\\"')}"`] : []),
    "---",
  ];
  kbWrite(path, lines.join("\n"));
}

/** Ensure mb dir exists (creates properties.md if missing) */
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

function toFromIdentifier(msg: { role: string; user_id?: number; user_name?: string; from_identifier?: string }): string {
  if (msg.role === "assistant") return "assistant";
  return (msg as { from_identifier?: string }).from_identifier ?? msg.user_name ?? (msg.user_id != null ? String(msg.user_id) : "user");
}

function toToIdentifier(busId: string): string {
  return busId;
}

/** Append message to bus history. */
export function appendToHistory(busId: string, message: Omit<HistoryMessage, "timestamp"> & { timestamp?: string }): void {
  const receivedAt = message.timestamp ?? new Date().toISOString();
  const fromId = toFromIdentifier(message);
  const toId = toToIdentifier(message.bus_id ?? busId);
  const messageId =
    message.mail_uid != null
      ? String(message.mail_uid)
      : message.event_uid ?? (message as { message_id?: string }).message_id ?? undefined;

  const stmt = getDb().prepare(`
    INSERT INTO messages (from_identifier, to_identifier, bus_id, text, received_at, message_id, role, mail_uid, event_uid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    fromId,
    toId,
    message.bus_id ?? busId,
    message.content,
    receivedAt,
    messageId ?? null,
    message.role,
    message.mail_uid ?? null,
    message.event_uid ?? null
  );
}

function rowToHistoryMessage(row: {
  from_identifier: string;
  bus_id: string;
  text: string;
  received_at: string;
  role: string;
  mail_uid: number | null;
  event_uid: string | null;
}): HistoryMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  const user_id = role === "user" && /^\d+$/.test(row.from_identifier) ? parseInt(row.from_identifier, 10) : undefined;
  const user_name = role === "user" && row.from_identifier !== "user" && !user_id ? row.from_identifier : undefined;
  return {
    role,
    content: row.text,
    user_id,
    user_name,
    bus_id: row.bus_id,
    timestamp: row.received_at,
    mail_uid: row.mail_uid ?? undefined,
    event_uid: row.event_uid ?? undefined,
  };
}

/** Get all messages for a bus, chronologically */
export function getBusHistory(busId: string): HistoryMessage[] {
  const stmt = getDb().prepare(
    "SELECT from_identifier, bus_id, text, received_at, role, mail_uid, event_uid FROM messages WHERE bus_id = ? ORDER BY received_at ASC"
  );
  const rows = stmt.all(busId) as Parameters<typeof rowToHistoryMessage>[0][];
  return rows.map(rowToHistoryMessage);
}

/** Get slice of bus history. offset=0, limit=N = last N. offset>0 = from start. offset<0 = from end. */
export function getBusHistorySlice(
  busId: string,
  limit: number = 50,
  offset: number = 0
): HistoryMessage[] {
  const full = getBusHistory(busId);
  if (offset === 0) return full.slice(-limit);
  if (offset > 0) return full.slice(offset, offset + limit);
  const from = Math.max(0, full.length + offset);
  return full.slice(from, from + limit);
}

/** Get list of mb_ids (buses) from messages. Root always included. */
export function getActiveBuses(): string[] {
  const stmt = getDb().prepare("SELECT DISTINCT bus_id FROM messages");
  const rows = stmt.all() as { bus_id: string }[];
  const buses = new Set(rows.map((r) => r.bus_id));
  buses.add("root");
  return Array.from(buses).filter(isValidBusIdFormat);
}

export type RootLogResult = { messages: HistoryMessage[]; trimmedCount: number };

function estimateMessageSize(m: HistoryMessage): number {
  return (m.content?.length ?? 0) + 200;
}

/** Get full root log (all messages, no trim). For get_bus_history with offset. */
export function getRootLogFull(): HistoryMessage[] {
  const buses = getActiveBuses();
  const all: HistoryMessage[] = [];
  for (const busId of buses) {
    all.push(...getBusHistory(busId));
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

/** Get root log: merged messages from all active buses, trimmed to latest that fit in maxChars. */
export function getRootLog(maxChars: number = 50_000): RootLogResult {
  const all = getRootLogFull();
  let total = 0;
  const result: HistoryMessage[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    const size = estimateMessageSize(m);
    if (total + size > maxChars && result.length > 0) break;
    result.unshift(m);
    total += size;
  }
  const trimmedCount = all.length - result.length;
  return { messages: result, trimmedCount };
}

/** Convert HistoryMessage to BusMessage (for compatibility with existing code) */
export function toBusMessage(m: HistoryMessage): {
  role: "user" | "assistant";
  content: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  timestamp?: string;
  mail_uid?: number;
  event_uid?: string;
} {
  return {
    role: m.role,
    content: m.content,
    user_id: m.user_id,
    user_name: m.user_name,
    bus_id: m.bus_id,
    timestamp: m.timestamp,
    mail_uid: m.mail_uid,
    event_uid: m.event_uid,
  };
}

/** Wipe root bus history (delete all root messages) */
export function wipeRootHistory(): void {
  deleteBusHistory("root");
}

/** Check if a message with this message_id already exists in bus history (Telegram msg.id, etc.). */
export function hasMessageIdInBusHistory(busId: string, messageId: string): boolean {
  const stmt = getDb().prepare("SELECT 1 FROM messages WHERE bus_id = ? AND message_id = ? LIMIT 1");
  const row = stmt.get(busId, messageId);
  return !!row;
}

/** Check if a message with this mail_uid already exists in bus history. */
export function hasMailUidInBusHistory(busId: string, mailUid: number): boolean {
  const stmt = getDb().prepare("SELECT 1 FROM messages WHERE bus_id = ? AND mail_uid = ? LIMIT 1");
  const row = stmt.get(busId, mailUid);
  return !!row;
}

/** Remove messages with given mail_uids from bus history. */
export function removeMessagesFromBusHistoryByMailUids(busId: string, uids: number[]): void {
  if (uids.length === 0) return;
  const stmt = getDb().prepare("DELETE FROM messages WHERE bus_id = ? AND mail_uid = ?");
  for (const uid of uids) stmt.run(busId, uid);
}

/** Check if an event with this event_uid already exists in bus history. */
export function hasEventInBusHistory(busId: string, eventUid: string): boolean {
  if (eventUid.length === 0) return false;
  const stmt = getDb().prepare("SELECT 1 FROM messages WHERE bus_id = ? AND event_uid = ? LIMIT 1");
  const row = stmt.get(busId, eventUid);
  return !!row;
}

/** Remove messages with given event_uids from bus history. */
export function removeMessagesFromBusHistoryByEventUids(busId: string, eventUids: string[]): void {
  if (eventUids.length === 0) return;
  const placeholders = eventUids.map(() => "?").join(",");
  getDb().prepare(`DELETE FROM messages WHERE bus_id = ? AND event_uid IN (${placeholders})`).run(busId, ...eventUids);
}

/** Delete all history for a bus */
export function deleteBusHistory(busId: string): void {
  getDb().prepare("DELETE FROM messages WHERE bus_id = ?").run(busId);
  const segment = busIdToPathSegment(busId);
  const base = `${HISTORY_BASE}/${segment}`;
  try {
    const all = kbList(base, true);
    for (const p of all) {
      try {
        kbDelete(p);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no history dir for this bus */
  }
}
