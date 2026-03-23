/**
 * Create Gmail and Calendar buses on startup when Google API is authorized.
 * Fetches profile and calendar list, ensures buses exist for bus statuses.
 */

import { getGmailClient, getCalendarClient } from "./google-api-agent.js";
import { ensureBus } from "./message-db.js";

function sanitizeForBusId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "default";
}

/** Check Google connection and create buses for Gmail and Calendars. Call on start-chat. */
export async function initGoogleBuses(): Promise<void> {
  const gmail = await getGmailClient();
  const calendar = await getCalendarClient();
  if (!gmail && !calendar) return;

  if (gmail) {
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const email = profile.data.emailAddress ?? "gmail";
      const busId = `gmail-${sanitizeForBusId(email)}`;
      ensureBus(busId, `Gmail: ${email}`);
    } catch (err) {
      console.warn("[YAAIA Google] Gmail profile fetch failed:", err);
    }
  }

  if (calendar) {
    try {
      const list = await calendar.calendarList.list();
      const items = list.data.items ?? [];
      for (const cal of items) {
        const id = cal.id ?? "unknown";
        const summary = cal.summary ?? id;
        const busId = `google-calendar-${sanitizeForBusId(id)}`;
        ensureBus(busId, `Calendar: ${summary}`);
      }
    } catch (err) {
      console.warn("[YAAIA Google] Calendar list fetch failed:", err);
    }
  }
}
