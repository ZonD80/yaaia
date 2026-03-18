/**
 * Gmail and Calendar API clients for agent TS eval.
 * Exposed when Google API is authorized via "Authorize Google API for agent".
 */

import { google } from "googleapis";
import { getGoogleOAuth2Client } from "./google-auth.js";

export type GmailClient = Awaited<ReturnType<typeof google.gmail>>;
export type CalendarClient = Awaited<ReturnType<typeof google.calendar>>;

/** Gmail API v1 client. null if not authorized. */
export async function getGmailClient(): Promise<GmailClient | null> {
  const auth = await getGoogleOAuth2Client();
  if (!auth) return null;
  return google.gmail({ version: "v1", auth });
}

/** Google Calendar API v3 client. null if not authorized. */
export async function getCalendarClient(): Promise<CalendarClient | null> {
  const auth = await getGoogleOAuth2Client();
  if (!auth) return null;
  return google.calendar({ version: "v3", auth });
}
