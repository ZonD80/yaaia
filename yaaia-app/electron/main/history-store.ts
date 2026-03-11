/**
 * Message bus history stored in kb/history/YYYY-MM-DD/{bus_id}/{seq}.md
 * Format: YAML frontmatter + content per message. 50K char limit per file.
 */

import { kbList, kbRead, kbWrite, kbDelete, kbEnsureCollection } from "./mcp-server/kb-client.js";

const HISTORY_BASE = "history";

const MAX_FILE_CHARS = 50_000;

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  user_id?: number;
  user_name?: string;
  bus_id?: string;
  timestamp: string;
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
      const trimmed = val.trim();
      if (key === "user_id" && /^\d+$/.test(trimmed)) {
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
    });
    i += 2;
  }
  return out;
}

/** Get today's date as YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** List .md files in history/YYYY-MM-DD/bus_id/ sorted by seq */
function listBusFiles(busId: string, date?: string): string[] {
  const segment = busIdToPathSegment(busId);
  const base = date ? `${HISTORY_BASE}/${date}/${segment}` : HISTORY_BASE;
  try {
    const all = kbList(base, true);
    const filtered = date
      ? all.filter((p) => p.startsWith(`${HISTORY_BASE}/${date}/${segment}/`) && p.endsWith(".md"))
      : all.filter((p) => p.includes(`/${segment}/`) && p.endsWith(".md"));
    return filtered.sort();
  } catch {
    return [];
  }
}

/** Ensure history collection exists for qmd indexing (call before update/embed) */
export async function ensureHistoryCollection(): Promise<void> {
  await kbEnsureCollection("history");
}

/** Get next sequence number for a bus on a given date */
function getNextSeq(busId: string, date: string): number {
  const files = listBusFiles(busId, date);
  if (files.length === 0) return 1;
  const last = files[files.length - 1];
  const match = last.match(/(\d+)\.md$/);
  return match ? parseInt(match[1], 10) + 1 : 1;
}

/** Append message to bus history. Creates new file if current exceeds 50K. Uses message.timestamp for path when provided. */
export function appendToHistory(busId: string, message: Omit<HistoryMessage, "timestamp"> & { timestamp?: string }): void {
  const ts = message.timestamp ?? new Date().toISOString();
  const full: HistoryMessage = {
    ...message,
    timestamp: ts,
  };
  const date = message.timestamp ? ts.slice(0, 10) : today();
  const segment = busIdToPathSegment(busId);
  const dir = `${HISTORY_BASE}/${date}/${segment}`;

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
  try {
    const entries = kbList(HISTORY_BASE, false);
    const dates = entries
      .map((p) => p.replace(`${HISTORY_BASE}/`, "").replace(/\/$/, "").split("/")[0])
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const uniqueDates = [...new Set(dates)].sort();
    for (const date of uniqueDates) {
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
  } catch {
    /* no history yet */
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

/** Get list of bus_ids that have at least one message in history */
export function getActiveBuses(): string[] {
  const buses = new Set<string>();
  try {
    const entries = kbList(HISTORY_BASE, false);
    const dates = entries
      .map((p) => p.replace(`${HISTORY_BASE}/`, "").replace(/\/$/, "").split("/")[0])
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const uniqueDates = [...new Set(dates)];
    for (const date of uniqueDates) {
      const datePath = `${HISTORY_BASE}/${date}`;
      try {
        const dirs = kbList(datePath, false);
        for (const dir of dirs) {
          const segment = (dir.endsWith("/") ? dir.slice(0, -1) : dir).split("/").pop() ?? "";
          if (segment && !segment.includes(".")) buses.add(pathSegmentToBusId(segment));
        }
      } catch {
        /* skip */
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
} {
  return {
    role: m.role,
    content: m.content,
    user_id: m.user_id,
    user_name: m.user_name,
    bus_id: m.bus_id,
  };
}

/** Wipe root bus history (delete all root .md files) */
export function wipeRootHistory(): void {
  deleteBusHistory("root");
}

/** Delete all history files for a bus */
export function deleteBusHistory(busId: string): void {
  try {
    const entries = kbList(HISTORY_BASE, false);
    const dates = entries
      .map((p) => p.replace(`${HISTORY_BASE}/`, "").replace(/\/$/, "").split("/")[0])
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const date of [...new Set(dates)]) {
      const files = listBusFiles(busId, date);
      for (const f of files) {
        try {
          kbDelete(f);
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* no history for this bus */
  }
}
