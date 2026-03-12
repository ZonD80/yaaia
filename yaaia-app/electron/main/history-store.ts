/**
 * Message bus history stored in kb/history/{mb_id}/{date}/{seq}.md
 * Bus properties in kb/history/{mb_id}/properties.md
 * Format: YAML frontmatter + content per message. 50K char limit per file.
 */

import { kbList, kbRead, kbWrite, kbDelete, kbEnsureCollection } from "./mcp-server/kb-client.js";

const HISTORY_BASE = "history";
const PROPERTIES_FILE = "properties.md";
const MAX_FILE_CHARS = 50_000;

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  timestamp: string;
  /** IMAP UID for email bus cleanup (delete from mailbox) */
  mail_uid?: number;
  /** CalDAV event UID for calendar event cleanup (delete from history when event deleted) */
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

/** Serialize message to YAML + content block */
function messageToBlock(m: HistoryMessage): string {
  const lines = [
    "---",
    `role: ${m.role}`,
    `bus_id: ${m.bus_id ?? "root"}`,
    `timestamp: ${m.timestamp}`,
  ];
  if (m.user_id !== undefined) lines.push(`user_id: ${m.user_id}`);
  if (m.user_name !== undefined) lines.push(`user_name: ${m.user_name}`);
  if (m.mail_uid !== undefined) lines.push(`mail_uid: ${m.mail_uid}`);
  if (m.event_uid !== undefined) lines.push(`event_uid: ${m.event_uid}`);
  lines.push("---", "", m.content, "");
  return lines.join("\n");
}

/** Parse a single .md file into messages */
function parseHistoryFile(content: string, busId: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  const parts = content.split(/\n---\n/);
  let i = 0;
  while (i < parts.length) {
    const yamlBlock = parts[i]?.trim();
    const body = parts[i + 1]?.trimEnd() ?? "";
    if (!yamlBlock || !yamlBlock.startsWith("role:")) {
      i++;
      continue;
    }
    const meta = parseYamlBlock(yamlBlock);
    const role = meta.role === "assistant" ? "assistant" : "user";
    const timestamp = typeof meta.timestamp === "string" ? meta.timestamp : new Date().toISOString();
    out.push({
      role,
      content: body,
      user_id: typeof meta.user_id === "number" ? meta.user_id : undefined,
      user_name: typeof meta.user_name === "string" ? meta.user_name : undefined,
      bus_id: typeof meta.bus_id === "string" ? meta.bus_id : busId,
      timestamp,
      mail_uid: typeof meta.mail_uid === "number" ? meta.mail_uid : undefined,
      event_uid: typeof meta.event_uid === "string" ? meta.event_uid : undefined,
    });
    i += 2;
  }
  return out;
}

/** Get today's date as YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Path to mb dir: history/{mb_id} */
function mbDirPath(mbId: string): string {
  return `${HISTORY_BASE}/${busIdToPathSegment(mbId)}`;
}

/** Path to properties: history/{mb_id}/properties.md */
function propertiesPath(mbId: string): string {
  return `${mbDirPath(mbId)}/${PROPERTIES_FILE}`;
}

/** Path to date dir: history/{mb_id}/{date} */
function dateDirPath(mbId: string, date: string): string {
  return `${mbDirPath(mbId)}/${date}`;
}

/** List .md files in history/{mb_id}/{date}/ sorted by seq */
function listBusFiles(mbId: string, date?: string): string[] {
  const segment = busIdToPathSegment(mbId);
  const base = date ? `${HISTORY_BASE}/${segment}/${date}` : HISTORY_BASE;
  try {
    const all = kbList(base, true);
    const prefix = date ? `${HISTORY_BASE}/${segment}/${date}/` : `${HISTORY_BASE}/${segment}/`;
    const filtered = all.filter((p) => p.startsWith(prefix) && p.endsWith(".md") && !p.endsWith(`/${PROPERTIES_FILE}`));
    return filtered.sort();
  } catch {
    return [];
  }
}

/** List date dirs (YYYY-MM-DD) for an mb */
function listDateDirs(mbId: string): string[] {
  const segment = busIdToPathSegment(mbId);
  const base = `${HISTORY_BASE}/${segment}`;
  try {
    const entries = kbList(base, false);
    return entries
      .map((e) => (e.endsWith("/") ? e.slice(0, -1) : e).split("/").pop() ?? "")
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch {
    return [];
  }
}

/** Ensure history collection exists for qmd indexing (call before update/embed) */
export async function ensureHistoryCollection(): Promise<void> {
  await kbEnsureCollection("history");
}

/** Get next sequence number for a bus on a given date */
function getNextSeq(mbId: string, date: string): number {
  const files = listBusFiles(mbId, date);
  if (files.length === 0) return 1;
  const last = files[files.length - 1];
  const match = last.match(/(\d+)\.md$/);
  return match ? parseInt(match[1], 10) + 1 : 1;
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
        is_banned: meta.is_banned === true || meta.is_banned === "true",
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
function ensureMbDir(mbId: string, props?: Partial<BusProperties>): void {
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

/** Append message to bus history. Creates new file if current exceeds 50K. Uses message.timestamp for path when provided. */
export function appendToHistory(busId: string, message: Omit<HistoryMessage, "timestamp"> & { timestamp?: string }): void {
  const ts = message.timestamp ?? new Date().toISOString();
  const full: HistoryMessage = {
    ...message,
    timestamp: ts,
  };
  const date = message.timestamp ? ts.slice(0, 10) : today();
  const dir = dateDirPath(busId, date);

  const files = listBusFiles(busId, date);
  let targetPath: string;
  let existingContent = "";

  if (files.length > 0) {
    const lastFile = files[files.length - 1];
    try {
      existingContent = kbRead(lastFile);
    } catch {
      /* file may have been deleted */
    }
    if (existingContent.length < MAX_FILE_CHARS) {
      targetPath = lastFile;
    } else {
      const nextSeq = getNextSeq(busId, date);
      targetPath = `${dir}/${String(nextSeq).padStart(3, "0")}.md`;
      const lastMessages = parseHistoryFile(existingContent, busId);
      const latest = lastMessages[lastMessages.length - 1];
      if (latest) {
        existingContent = messageToBlock(latest);
      } else {
        existingContent = "";
      }
    }
  } else {
    targetPath = `${dir}/001.md`;
  }

  const newContent = existingContent ? existingContent + "\n" + messageToBlock(full) : messageToBlock(full);
  kbWrite(targetPath, newContent);
}

/** Get all messages for a bus, chronologically */
export function getBusHistory(busId: string): HistoryMessage[] {
  const all: HistoryMessage[] = [];
  const dates = listDateDirs(busId);
  for (const date of dates) {
    const files = listBusFiles(busId, date);
    for (const f of files) {
      try {
        const content = kbRead(f);
        all.push(...parseHistoryFile(content, busId));
      } catch {
        /* skip */
      }
    }
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
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

/** Get list of mb_ids (buses) from history/ subdirs */
export function getActiveBuses(): string[] {
  const buses = new Set<string>();
  try {
    const entries = kbList(HISTORY_BASE, false);
    for (const e of entries) {
      const segment = (e.endsWith("/") ? e.slice(0, -1) : e).split("/").pop() ?? "";
      if (segment && !segment.includes(".")) {
        buses.add(pathSegmentToBusId(segment));
      }
    }
  } catch {
    /* no history */
  }
  return Array.from(buses);
}

export type RootLogResult = { messages: HistoryMessage[]; trimmedCount: number };

/** Get full root log (all messages, no trim). For get_bus_history with offset. */
export function getRootLogFull(): HistoryMessage[] {
  const buses = getActiveBuses();
  const all: HistoryMessage[] = [];
  for (const busId of buses) {
    for (const m of getBusHistory(busId)) {
      all.push(m);
    }
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

/** Get root log: merged messages from all active buses, trimmed to latest that fit in maxChars. Returns messages and count of trimmed (older) messages. */
export function getRootLog(maxChars: number = 50_000): RootLogResult {
  const buses = getActiveBuses();
  const all: HistoryMessage[] = [];
  for (const busId of buses) {
    for (const m of getBusHistory(busId)) {
      all.push(m);
    }
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let total = 0;
  const result: HistoryMessage[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    const size = messageToBlock(m).length;
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

/** Wipe root bus history (delete all root message files, keep properties) */
export function wipeRootHistory(): void {
  deleteBusHistory("root");
}

/** Remove messages with given mail_uids from bus history. Used when deleting mail messages from mailbox. */
export function removeMessagesFromBusHistoryByMailUids(busId: string, uids: number[]): void {
  if (uids.length === 0) return;
  const uidSet = new Set(uids);
  const dates = listDateDirs(busId);
  for (const date of dates) {
    const files = listBusFiles(busId, date);
    for (const f of files) {
      try {
        const content = kbRead(f);
        const messages = parseHistoryFile(content, busId);
        const remaining = messages.filter((m) => !(m.mail_uid !== undefined && uidSet.has(m.mail_uid)));
        if (remaining.length === 0) {
          kbDelete(f);
        } else {
          const newContent = remaining.map((m) => messageToBlock(m)).join("\n");
          kbWrite(f, newContent);
        }
      } catch {
        /* skip */
      }
    }
  }
}

function extractEventUidFromContent(content: string): string | undefined {
  const m = content.match(/Event UID:\s*(.+)$/m);
  return m ? m[1].trim() : undefined;
}

/** Check if an event with this event_uid already exists in bus history. Used to avoid duplicate CalDAV events on reconnect. */
export function hasEventInBusHistory(busId: string, eventUid: string): boolean {
  const messages = getBusHistory(busId);
  if (eventUid.length === 0) return false;
  return messages.some((m) => {
    const uid = m.event_uid ?? extractEventUidFromContent(m.content);
    return uid === eventUid;
  });
}

/** Remove messages with given event_uids from bus history. Used when deleting CalDAV events. */
export function removeMessagesFromBusHistoryByEventUids(busId: string, eventUids: string[]): void {
  if (eventUids.length === 0) return;
  const uidSet = new Set(eventUids);
  const dates = listDateDirs(busId);
  for (const date of dates) {
    const files = listBusFiles(busId, date);
    for (const f of files) {
      try {
        const content = kbRead(f);
        const messages = parseHistoryFile(content, busId);
        const remaining = messages.filter((m) => {
          const uid = m.event_uid ?? extractEventUidFromContent(m.content);
          return !(uid !== undefined && uidSet.has(uid));
        });
        if (remaining.length === 0) {
          kbDelete(f);
        } else {
          const newContent = remaining.map((m) => messageToBlock(m)).join("\n");
          kbWrite(f, newContent);
        }
      } catch {
        /* skip */
      }
    }
  }
}

/** Delete all history and properties for a bus */
export function deleteBusHistory(busId: string): void {
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
    /* no history for this bus */
  }
}

export { ensureMbDir };
