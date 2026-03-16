/**
 * Prefix-based message routing: bus_id:content or bus_id:wait:content
 * First colon separates bus_id from content. Multiline: content until next bus_id: line.
 */

import { listBuses, ensureBus, ROOT_BUS_ID } from "./message-bus-store.js";
import { appendToBusHistory } from "./message-bus-store.js";
import * as recipeStore from "./recipe-store.js";
import { waitForUserReply } from "./ask-user-bridge.js";
import { caldavCreateEvent } from "./caldav-client.js";

/** Regex: line starting with bus_id: or bus_id:wait: (bus_id = alphanumeric, underscore, hyphen) */
const PREFIX_RE = /^([a-zA-Z0-9_-]+):(wait:)?(.*)$/;

export type ParsedMessage = {
  busId: string;
  content: string;
  waitForAnswer: boolean;
};

export type RouteMessageResult = {
  ok: boolean;
  error?: string;
  /** When waitForAnswer was true and we waited, the user's reply. */
  reply?: string;
};

/** Validate bus_id: root, or known buses, or standard patterns (telegram-*, email-*, caldav-*). */
export function isValidBusId(busId: string): boolean {
  if (!busId?.trim()) return false;
  if (busId === ROOT_BUS_ID) return true;
  const buses = listBuses();
  if (buses.some((b) => b.bus_id === busId)) return true;
  if (/^telegram-\d+$/.test(busId)) return true;
  if (/^email-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  if (/^caldav-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+$/.test(busId)) return true;
  return false;
}

/**
 * Parse text into prefix-routed messages.
 * Format: bus_id:content or bus_id:wait:content. Multiline: content continues until next bus_id: line.
 */
export function parsePrefixedMessages(text: string): ParsedMessage[] {
  const result: ParsedMessage[] = [];
  const lines = text.split("\n");
  let current: { busId: string; waitForAnswer: boolean; parts: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(PREFIX_RE);
    if (m) {
      const [, busId, waitPart, rest] = m;
      if (current) {
        const raw = current.parts.join("\n").trim();
        const content = raw.replace(/\\n/g, "\n");
        if (content && isValidBusId(current.busId)) {
          result.push({
            busId: current.busId,
            content,
            waitForAnswer: current.waitForAnswer,
          });
        }
      }
      current = {
        busId: busId ?? "",
        waitForAnswer: !!waitPart,
        parts: rest ? [rest] : [],
      };
    } else if (current) {
      current.parts.push(line);
    }
  }
  if (current) {
    const raw = current.parts.join("\n").trim();
    const content = raw.replace(/\\n/g, "\n");
    if (content && isValidBusId(current.busId)) {
      result.push({
        busId: current.busId,
        content,
        waitForAnswer: current.waitForAnswer,
      });
    }
  }
  return result;
}

/** Stream parser: accumulates chunks, yields complete messages when a new bus_id: line starts. */
export class StreamPrefixParser {
  private buffer = "";
  private current: { busId: string; waitForAnswer: boolean; parts: string[] } | null = null;

  feed(chunk: string): ParsedMessage[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    const complete = lines.length > 1;
    this.buffer = complete ? lines.pop() ?? "" : this.buffer;
    const toProcess = complete ? lines.join("\n") + "\n" : "";

    const result: ParsedMessage[] = [];
    for (const line of toProcess.split("\n")) {
      const m = line.match(PREFIX_RE);
      if (m) {
        const [, busId, waitPart, rest] = m;
        if (this.current) {
          const raw = this.current.parts.join("\n").trim();
          const content = raw.replace(/\\n/g, "\n");
          if (content && isValidBusId(this.current.busId)) {
            result.push({
              busId: this.current.busId,
              content,
              waitForAnswer: this.current.waitForAnswer,
            });
          }
        }
        this.current = {
          busId: busId ?? "",
          waitForAnswer: !!waitPart,
          parts: rest ? [rest] : [],
        };
      } else if (this.current) {
        this.current.parts.push(line);
      }
    }
    return result;
  }

  flush(): ParsedMessage[] {
    const result: ParsedMessage[] = [];
    if (this.current) {
      const raw = (this.current.parts.join("\n") + "\n" + this.buffer).trim();
      const content = raw.replace(/\\n/g, "\n");
      if (content && isValidBusId(this.current.busId)) {
        result.push({
          busId: this.current.busId,
          content,
          waitForAnswer: this.current.waitForAnswer,
        });
      }
    }
    this.buffer = "";
    this.current = null;
    return result;
  }
}

/** Parse CalDAV structured content: summary|start|end or summary\\nstart\\nend. Optional description on following lines. */
export function parseCaldavStructured(content: string): {
  summary: string;
  start: string;
  end: string;
  description?: string;
} | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[|\n]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const [summary, start, end] = parts;
  const description = parts.slice(3).join("\n").trim() || undefined;
  if (!summary || !start || !end) return null;
  return { summary, start, end, description };
}

/** Build minimal iCal string for event creation. Accepts ISO 8601 dates. */
function buildIcalEvent(summary: string, start: string, end: string, description?: string): string {
  const uid = `yaaia-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").slice(0, 15) + "Z";
  const toIcal = (s: string) => {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s.replace(/[-:]/g, "").replace(/\.\d{3}/, "").slice(0, 15) + "Z";
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").slice(0, 15) + "Z";
  };
  const dtStart = toIcal(start);
  const dtEnd = toIcal(end);
  const desc = description ? `DESCRIPTION:${description.replace(/\n/g, "\\n")}\n` : "";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//YAAIA//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${summary.replace(/\n/g, " ")}`,
    desc,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

export type RouteCallbacks = {
  onSendMessageToRoot?: (content: string) => void;
  onSendMessageToTelegram?: (busId: string, content: string) => void | Promise<void>;
  onAskUserRequest?: (info: { clarification: string; assessment: string; attempt: number }) => void;
  onAskUserTimeout?: () => void;
  getCalendarUrlForBusId?: (busId: string) => string | null;
};

/**
 * Route a parsed message to the appropriate destination.
 * - root: append history, onSendMessageToRoot
 * - telegram-*: append history, onSendMessageToTelegram
 * - email-*: append history only (agent uses mail.append for sending)
 * - caldav-*: if structured (summary|start|end), create event; else append history
 */
export async function routeMessage(
  msg: ParsedMessage,
  callbacks: RouteCallbacks
): Promise<RouteMessageResult> {
  const { busId, content, waitForAnswer } = msg;
  ensureBus(busId);
  appendToBusHistory(busId, { role: "assistant", content });
  if (busId === ROOT_BUS_ID && !waitForAnswer) recipeStore.setPendingReportFromSendMessage(content);

  const displayContent = busId === ROOT_BUS_ID ? content : `[${busId}] ${content}`;
  callbacks.onSendMessageToRoot?.(displayContent);

  if (busId.startsWith("telegram-")) {
    try {
      await callbacks.onSendMessageToTelegram?.(busId, content);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      recipeStore.appendToolCall("send_message", { bus_id: busId, content }, m);
      return { ok: false, error: m };
    }
  }

  if (busId.startsWith("caldav-") && callbacks.getCalendarUrlForBusId) {
    const parsed = parseCaldavStructured(content);
    if (parsed) {
      const calendarUrl = callbacks.getCalendarUrlForBusId(busId);
      if (calendarUrl) {
        try {
          const ical = buildIcalEvent(parsed.summary, parsed.start, parsed.end, parsed.description);
          const filename = `${parsed.summary.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.ics`;
          await caldavCreateEvent(calendarUrl, filename, ical);
          recipeStore.appendToolCall("send_message", { bus_id: busId, content }, "Event created.");
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          recipeStore.appendToolCall("send_message", { bus_id: busId, content }, m);
          return { ok: false, error: m };
        }
      }
    }
  }

  if (waitForAnswer && (busId === ROOT_BUS_ID || busId.startsWith("telegram-"))) {
    if (busId === ROOT_BUS_ID) {
      callbacks.onAskUserRequest?.({ clarification: content, assessment: "", attempt: 0 });
    }
    const reply = await waitForUserReply({
      timeoutMs: 60_000,
      onTimeout: callbacks.onAskUserTimeout,
      busId: busId !== ROOT_BUS_ID ? busId : undefined,
    });
    recipeStore.appendToolCall("ask", { bus_id: busId, prompt: content }, reply);
    return { ok: true, reply };
  }

  recipeStore.appendToolCall("send_message", { bus_id: busId, content }, `[${busId}] ${content}`);
  return { ok: true };
}
