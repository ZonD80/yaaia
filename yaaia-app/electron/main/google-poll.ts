/**
 * Poll Gmail and Google Calendar every 5 minutes.
 * Emits new messages/events to bus history with IDs so the model can fetch full content.
 * Database is the source of truth for what we've already delivered.
 */

import { getGmailClient, getCalendarClient } from "./google-api-agent.js";
import { ensureBus, hasMessageIdInBusHistory, hasEventInBusHistory } from "./message-db.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;
let onGmailMessage: ((payload: GmailMessagePayload) => void) | null = null;
let onCalendarEvent: ((payload: CalendarEventPayload) => void) | null = null;

export type GmailMessagePayload = {
  bus_id: string;
  message_id: string;
  content: string;
  user_name: string;
  timestamp: string;
};

export type CalendarEventPayload = {
  bus_id: string;
  calendar_id: string;
  event_id: string;
  content: string;
  timestamp: string;
};

function sanitizeForBusId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "default";
}

export function setOnGmailMessage(cb: ((payload: GmailMessagePayload) => void) | null): void {
  onGmailMessage = cb;
}

export function setOnCalendarEvent(cb: ((payload: CalendarEventPayload) => void) | null): void {
  onCalendarEvent = cb;
}

export function startGooglePoll(): void {
  if (pollIntervalHandle) return;
  console.log(`[YAAIA Google] Starting poll (interval ${POLL_INTERVAL_MS / 1000}s)`);
  pollIntervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  poll().catch((err) => console.warn("[YAAIA Google] Initial poll failed:", err));
}

export function stopGooglePoll(): void {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
}

async function poll(): Promise<void> {
  const gmail = await getGmailClient();
  const calendar = await getCalendarClient();
  if (!gmail && !calendar) {
    console.log("[YAAIA Google] Poll skipped: no Gmail or Calendar client");
    return;
  }

  if (gmail) {
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const email = profile.data.emailAddress ?? "gmail";
      const busId = `gmail-${sanitizeForBusId(email)}`;
      ensureBus(busId, `Gmail: ${email}`);

      console.log(`[YAAIA Google] Gmail poll: bus=${busId} onGmailMessage=${onGmailMessage ? "set" : "null"}`);

      const res = await gmail.users.messages.list({ userId: "me", maxResults: 50 });
      const messages = res.data.messages ?? [];
      console.log(`[YAAIA Google] Gmail list returned ${messages.length} messages`);

      let delivered = 0;
      let skipped = 0;

      for (const m of messages) {
        const id = m.id;
        if (!id) continue;
        if (hasMessageIdInBusHistory(busId, id)) {
          skipped++;
          continue;
        }

        try {
          const full = await gmail.users.messages.get({ userId: "me", id });
          console.log(`[YAAIA Google] Gmail new message id=${id}: fetching full content`);
          const payload = full.data.payload;
          const headers = payload?.headers ?? [];
          const getHeader = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
          const subject = getHeader("Subject");
          const from = getHeader("From");
          const snippet = (full.data.snippet ?? "").slice(0, 200);
          const internalDate = full.data.internalDate;
          const timestamp = internalDate ? new Date(Number(internalDate)).toISOString() : new Date().toISOString();

          const content = `[New email] id=${id} | From: ${from} | Subject: ${subject} | Snippet: ${snippet}`;
          onGmailMessage?.({
            bus_id: busId,
            message_id: id,
            content,
            user_name: from || "Gmail",
            timestamp,
          });
          delivered++;
          console.log(`[YAAIA Google] Gmail delivered new message id=${id} to bus`);
        } catch (err) {
          console.warn("[YAAIA Google] Gmail message fetch failed:", err);
        }
      }

      console.log(`[YAAIA Google] Gmail poll done: ${delivered} new delivered, ${skipped} skipped (in DB)`);
    } catch (err) {
      console.warn("[YAAIA Google] Gmail poll failed:", err);
    }
  }

  if (calendar) {
    try {
      const list = await calendar.calendarList.list();
      const items = list.data.items ?? [];
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const twoMonthsAhead = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

      for (const cal of items) {
        const calId = cal.id ?? "unknown";
        const summary = cal.summary ?? calId;
        const busId = `google-calendar-${sanitizeForBusId(calId)}`;
        ensureBus(busId, `Calendar: ${summary}`);

        const res = await calendar.events.list({
          calendarId: calId,
          timeMin: weekAgo.toISOString(),
          timeMax: twoMonthsAhead.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });
        const events = res.data.items ?? [];

        for (const ev of events) {
          const id = ev.id;
          if (!id) continue;
          if (hasEventInBusHistory(busId, id)) continue;

          const start = ev.start?.dateTime ?? ev.start?.date ?? "";
          const end = ev.end?.dateTime ?? ev.end?.date ?? "";
          const evSummary = ev.summary ?? "(no title)";
          const location = ev.location ?? "";
          const timestamp = ev.updated ?? ev.created ?? new Date().toISOString();

          const content = `[New event] id=${id} | Summary: ${evSummary} | Start: ${start} | End: ${end}${location ? ` | Location: ${location}` : ""}`;
          onCalendarEvent?.({
            bus_id: busId,
            calendar_id: calId,
            event_id: id,
            content,
            timestamp,
          });
        }
      }
    } catch (err) {
      console.warn("[YAAIA Google] Calendar poll failed:", err);
    }
  }
}
