/**
 * CalDAV client wrapper using tsdav.
 * Single connection per session. Polls every 5 min for changes. Auto-reconnects on failure.
 */

import { createDAVClient } from "tsdav";
import type { DAVClient } from "tsdav";
import type { DAVCalendar, DAVCalendarObject } from "tsdav";
import { fetchOauthTokens } from "tsdav";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { getActiveBuses, deleteBusHistory, hasEventInBusHistory } from "./history-store.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RECONNECT_DELAY_MS = 5_000;

const GOOGLE_CALDAV_SERVER = "https://apidata.googleusercontent.com/caldav/v2/";
const GOOGLE_TOKEN_URL = "https://accounts.google.com/o/oauth2/token";
const GOOGLE_AUTH_SCOPE = "https://www.googleapis.com/auth/calendar";

function sanitizeForBusId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "default";
}

export type CaldavEventPayload = {
  bus_id: string;
  calendar_id: string;
  calendar_display_name: string;
  event_uid: string;
  summary: string;
  start: string; // RFC 3339
  end: string;
  location?: string;
  description?: string;
  url?: string;
  ics_data: string;
  is_new: boolean;
};

export type OnCaldavEventCallback = (payload: CaldavEventPayload, opts?: { deliverToModel?: boolean }) => void;

export type CaldavConnectParamsBasic = {
  authMethod: "Basic";
  serverUrl: string;
  username: string;
  password: string;
};

export type CaldavConnectParamsOAuth = {
  authMethod: "OAuth";
  provider: "google";
  /** From passwords or config. If missing, OAuth flow will run. */
  refreshToken?: string;
  username?: string;
  clientId?: string;
  clientSecret?: string;
};

export type CaldavConnectParams = CaldavConnectParamsBasic | CaldavConnectParamsOAuth;

let client: DAVClient | null = null;
let storedParams: CaldavConnectParams | null = null;
let onCaldavEvent: OnCaldavEventCallback | null = null;
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;
let reconnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
type LastKnownEntry = { etag?: string; dataHash: string; eventUid?: string; busId?: string };
let lastKnownEvents: Map<string, LastKnownEntry> = new Map();
let currentAccount: string | null = null;
let currentCalendars: { calendar: DAVCalendar; busId: string }[] = [];
let onCaldavEventDeleted: ((eventUid: string, busId: string) => void) | null = null;

export function setOnCaldavEvent(cb: OnCaldavEventCallback | null): void {
  onCaldavEvent = cb;
}

export function setOnCaldavEventDeleted(cb: ((eventUid: string, busId: string) => void) | null): void {
  onCaldavEventDeleted = cb;
}

export function isCaldavConnected(): boolean {
  return client !== null;
}

function getLastEventsPath(account: string): string {
  return join(YAAIA_DIR, `caldav-last-${sanitizeForBusId(account)}.json`);
}

function loadLastEvents(account: string): Record<string, LastKnownEntry> {
  try {
    const path = getLastEventsPath(account);
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      return typeof raw?.mapping === "object" ? raw.mapping : {};
    }
  } catch (err) {
    console.warn("[YAAIA CalDAV] Failed to load last events:", err);
  }
  return {};
}

function saveLastEvents(account: string, mapping: Record<string, LastKnownEntry>): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    const path = getLastEventsPath(account);
    writeFileSync(path, JSON.stringify({ mapping }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[YAAIA CalDAV] Failed to save last events:", err);
  }
}

function simpleHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function parseIcsEvent(icsData: string): { uid?: string; summary?: string; start?: string; end?: string; location?: string; description?: string; url?: string } {
  const result: Record<string, string> = {};
  const lines = icsData.split(/\r?\n/);
  let inEvent = false;
  let currentKey = "";
  let currentValue = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith(" ") || line.startsWith("\t")) {
      currentValue += line.slice(1);
      continue;
    }
    if (currentKey) {
      result[currentKey] = currentValue.replace(/\\n/g, "\n").replace(/\\,/g, ",");
      currentKey = "";
      currentValue = "";
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(";")[0].trim();
    const value = line.slice(colon + 1).trim();
    if (key === "BEGIN" && value === "VEVENT") {
      inEvent = true;
      continue;
    }
    if (key === "END" && value === "VEVENT") {
      inEvent = false;
      break;
    }
    if (!inEvent) continue;
    const k = key.toUpperCase();
    if (k === "UID") result.uid = value;
    else if (k === "SUMMARY") result.summary = value;
    else if (k === "DTSTART") result.start = parseIcsDate(value);
    else if (k === "DTEND") result.end = parseIcsDate(value);
    else if (k === "LOCATION") result.location = value;
    else if (k === "DESCRIPTION") result.description = value;
    else if (k === "URL") result.url = value;
  }
  if (currentKey) result[currentKey] = currentValue;
  return result;
}

function parseIcsDate(val: string): string {
  if (!val) return "";
  if (val.includes("T") && val.length >= 15) {
    const d = val.replace(/-/g, "").replace(/:/g, "").replace("Z", "");
    const hasTz = val.endsWith("Z") || /[+-]\d{4}$/.test(val);
    if (d.length >= 15) {
      const y = d.slice(0, 4);
      const m = d.slice(4, 6);
      const day = d.slice(6, 8);
      const h = d.slice(9, 11) || "00";
      const min = d.slice(11, 13) || "00";
      const sec = d.slice(13, 15) || "00";
      return `${y}-${m}-${day}T${h}:${min}:${sec}${hasTz ? "Z" : ""}`;
    }
  }
  if (val.length === 8) {
    return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}T00:00:00`;
  }
  return val;
}

async function scheduleReconnect(): Promise<void> {
  if (reconnectTimeoutHandle) return;
  if (!storedParams) return;
  console.log("[YAAIA CalDAV] Scheduling reconnect in", RECONNECT_DELAY_MS, "ms");
  reconnectTimeoutHandle = setTimeout(async () => {
    reconnectTimeoutHandle = null;
    try {
      console.log("[YAAIA CalDAV] Attempting reconnect...");
      await caldavConnect(storedParams!);
      if (currentAccount) await caldavInitAndWatch(currentAccount);
    } catch (err) {
      console.warn("[YAAIA CalDAV] Reconnect failed:", err instanceof Error ? err.message : String(err));
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

/** Start OAuth server for browser-based flow. Agent navigates to url, user signs in, redirect shows tokens. Returns { url, redirectUrl, closeServer }. */
export async function startGoogleOAuthBrowserServer(
  clientId: string,
  clientSecret: string
): Promise<{ url: string; redirectUrl: string; port: number; closeServer: () => void }> {
  const server = createServer();

  const closeServer = (): void => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };

  const OAUTH_SERVER_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  const timeout = setTimeout(() => {
    closeServer();
  }, OAUTH_SERVER_TIMEOUT_MS);

  server.on("request", async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = reqUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>OAuth Error</h2><p>No authorization code in redirect.</p><pre id='caldav-tokens'>{\"error\":\"no_code\"}</pre></body></html>"
      );
      return;
    }

    try {
      const tokens = await fetchOauthTokens({
        authorizationCode: code,
        clientId,
        clientSecret,
        tokenUrl: GOOGLE_TOKEN_URL,
        redirectUrl: `http://localhost:${port}/callback`,
      });

      const refreshToken = tokens.refresh_token ?? "";
      let username = "";
      try {
        const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (resp.ok) {
          const user = (await resp.json()) as { email?: string };
          username = user.email ?? "";
        }
      } catch {
        /* ignore */
      }

      const tokensJson = JSON.stringify({ refreshToken, username }, null, 2);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CalDAV OAuth</title></head><body>` +
          `<h2>Authorization complete</h2>` +
          `<p>Copy the tokens below and save via <strong>passwords.set</strong>. Then call <strong>caldav.connect</strong> with credentials_password_id.</p>` +
          `<pre id="caldav-tokens">${tokensJson.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>` +
          `</body></html>`
      );
      clearTimeout(timeout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h2>OAuth Error</h2><p>${String(msg).replace(/</g, "&lt;")}</p><pre id="caldav-tokens">{"error":"${String(msg).replace(/"/g, '\\"')}"}</pre></body></html>`
      );
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object" && addr.port) resolve(addr.port);
      else reject(new Error("Could not get port"));
    });
    server.on("error", reject);
  });

  const redirectUrl = `http://localhost:${port}/callback`;
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUrl,
      response_type: "code",
      scope: GOOGLE_AUTH_SCOPE,
      access_type: "offline",
      prompt: "consent",
    }).toString();

  return { url, redirectUrl, port, closeServer };
}

export async function caldavConnect(
  params: CaldavConnectParams,
  opts?: { googleClientId?: string; googleClientSecret?: string }
): Promise<void> {
  await caldavDisconnect();
  storedParams = params;

  if (params.authMethod === "OAuth" && params.provider === "google") {
    let clientId = params.clientId ?? opts?.googleClientId ?? "";
    let clientSecret = params.clientSecret ?? opts?.googleClientSecret ?? "";
    const refreshToken = params.refreshToken;
    const username = params.username ?? "";

    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth requires clientId and clientSecret. Configure them in app settings.");
    }

    if (!refreshToken) {
      throw new Error(
        "No refreshToken. Run caldav.oauth_browser first: it returns the OAuth URL; user opens it in a browser, signs in, redirect page shows tokens. Save tokens via passwords.set, then call caldav.connect with credentials_password_id."
      );
    }

    client = (await createDAVClient({
      serverUrl: GOOGLE_CALDAV_SERVER,
      credentials: {
        tokenUrl: GOOGLE_TOKEN_URL,
        username: username || "user",
        refreshToken,
        clientId,
        clientSecret,
      },
      authMethod: "Oauth",
      defaultAccountType: "caldav",
    })) as DAVClient;

    currentAccount = username || "google";
  } else if (params.authMethod === "Basic") {
    const { serverUrl, username, password } = params;
    client = (await createDAVClient({
      serverUrl,
      credentials: { username, password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    })) as DAVClient;
    currentAccount = username;
  } else {
    throw new Error("Unsupported auth method");
  }

  lastKnownEvents = new Map(Object.entries(loadLastEvents(currentAccount)));
}

export async function caldavDisconnect(): Promise<void> {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
  if (reconnectTimeoutHandle) {
    clearTimeout(reconnectTimeoutHandle);
    reconnectTimeoutHandle = null;
  }
  client = null;
  storedParams = null;
  currentAccount = null;
  currentCalendars = [];
  lastKnownEvents.clear();
}

/** Fetch calendars, create buses, start polling. Call after caldavConnect. */
export async function caldavInitAndWatch(account: string): Promise<{ calendars: { busId: string; displayName: string }[] }> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");

  const calendars = await c.fetchCalendars();
  const accountSanitized = sanitizeForBusId(account);
  currentCalendars = calendars.map((cal) => {
    const displayName = (cal.displayName as string) ?? "";
    const busId = `caldav-${accountSanitized}-${sanitizeForBusId(displayName)}`;
    return { calendar: cal, busId };
  });

  lastKnownEvents = new Map(Object.entries(loadLastEvents(account)));

  // Wipe stale caldav-* buses (renamed or removed calendars). Only when we got a non-empty
  // calendar list — empty list may mean fetch failed (e.g. 401), not that calendars were removed.
  const newBusIds = new Set(currentCalendars.map((c) => c.busId));
  if (newBusIds.size > 0) {
    for (const b of getActiveBuses()) {
      if (b.startsWith("caldav-") && !newBusIds.has(b)) {
        console.log("[YAAIA CalDAV] Wiping stale bus:", b);
        deleteBusHistory(b);
        // Also purge lastKnownEvents entries so events re-download under new bus ID.
        for (const [url, entry] of lastKnownEvents) {
          if (entry.busId === b) lastKnownEvents.delete(url);
        }
      }
    }
  }
  if (currentAccount) saveLastEvents(currentAccount, Object.fromEntries(lastKnownEvents));

  const doPoll = async (): Promise<void> => {
    if (!client || !currentAccount) return;
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const end = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

      for (const { calendar, busId } of currentCalendars) {
        try {
          const objects = await c.fetchCalendarObjects({
            calendar,
            timeRange: { start, end },
          });
          const fetchedUrls = new Set(objects.map((o) => o.url ?? "").filter(Boolean));

          for (const obj of objects) {
            const url = obj.url ?? "";
            const data = typeof obj.data === "string" ? obj.data : "";
            const dataHash = simpleHash(data);
            const etag = obj.etag;
            const prev = lastKnownEvents.get(url);
            const isNew = !prev;
            const isChanged = prev && prev.dataHash !== dataHash;

            if (isNew || isChanged) {
              const parsed = parseIcsEvent(data);
              const uid = parsed.uid ?? url;

              // Deduplicate by eventUid: same event can have different object URLs between polls (e.g. Google).
              // If we've already seen this eventUid for this bus, update URL mapping but skip emit.
              const existingByUid = [...lastKnownEvents.entries()].find(
                ([_, e]) => e.eventUid === uid && e.busId === busId
              );
              if (existingByUid) {
                const [oldUrl] = existingByUid;
                lastKnownEvents.delete(oldUrl);
                lastKnownEvents.set(url, { etag, dataHash, eventUid: uid, busId });
                continue; // already delivered, skip
              }
              if (hasEventInBusHistory(busId, uid) && !isChanged) {
                lastKnownEvents.set(url, { etag, dataHash, eventUid: uid, busId });
                continue; // already in history and unchanged, skip
              }

              lastKnownEvents.set(url, { etag, dataHash, eventUid: uid, busId });
              const displayName = (calendar.displayName as string) ?? calendar.url ?? "Calendar";

              const payload: CaldavEventPayload = {
                bus_id: busId,
                calendar_id: calendar.url ?? "",
                calendar_display_name: displayName,
                event_uid: uid,
                summary: parsed.summary ?? "(no title)",
                start: parsed.start ?? "",
                end: parsed.end ?? "",
                location: parsed.location,
                description: parsed.description,
                url: parsed.url,
                ics_data: data,
                is_new: isNew,
              };
              onCaldavEvent?.(payload, { deliverToModel: true });
            }
          }

          const calendarUrl = calendar.url ?? "";
          const toRemove: string[] = [];
          for (const [url, entry] of lastKnownEvents) {
            const belongsToCalendar = entry.busId === busId || (!entry.busId && calendarUrl && url.startsWith(calendarUrl));
            if (belongsToCalendar && !fetchedUrls.has(url)) {
              toRemove.push(url);
              if (entry.eventUid) onCaldavEventDeleted?.(entry.eventUid, busId);
            }
          }
          for (const url of toRemove) lastKnownEvents.delete(url);
        } catch (err) {
          console.warn("[YAAIA CalDAV] Poll error for", busId, err instanceof Error ? err.message : String(err));
          const isConnErr =
            /ECONNRESET|ETIMEDOUT|ECONNREFUSED|401|403|500|network/i.test(
              err instanceof Error ? err.message : String(err)
            );
          if (isConnErr) {
            client = null;
            scheduleReconnect();
            return;
          }
        }
      }

      saveLastEvents(currentAccount, Object.fromEntries(lastKnownEvents));
    } catch (err) {
      console.warn("[YAAIA CalDAV] Poll failed:", err instanceof Error ? err.message : String(err));
      client = null;
      scheduleReconnect();
    }
  };

  await doPoll();
  pollIntervalHandle = setInterval(doPoll, POLL_INTERVAL_MS);

  return {
    calendars: currentCalendars.map((c) => ({
      busId: c.busId,
      displayName: (c.calendar.displayName as string) ?? "",
      url: c.calendar.url ?? "",
    })),
  };
}

export async function caldavListCalendars(): Promise<Array<{ url: string; displayName: string }>> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");
  const calendars = await c.fetchCalendars();
  return calendars.map((cal) => ({
    url: cal.url ?? "",
    displayName: (cal.displayName as string) ?? cal.url ?? "",
  }));
}

/** Get calendar URL for a caldav bus_id. Returns null if not found or not connected. */
export function caldavGetCalendarUrlForBusId(busId: string): string | null {
  if (!busId.startsWith("caldav-")) return null;
  const match = currentCalendars.find((c) => c.busId === busId);
  return match ? (match.calendar.url ?? null) : null;
}

export async function caldavListEvents(
  calendarUrl: string,
  start: string,
  end: string
): Promise<DAVCalendarObject[]> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");
  const calendars = await c.fetchCalendars();
  const cal = calendars.find((x) => x.url === calendarUrl);
  if (!cal) throw new Error(`Calendar not found: ${calendarUrl}`);
  return c.fetchCalendarObjects({
    calendar: cal,
    timeRange: { start, end },
  });
}

export async function caldavGetEvent(calendarUrl: string, objectUrl: string): Promise<DAVCalendarObject | null> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");
  const calendars = await c.fetchCalendars();
  const cal = calendars.find((x) => x.url === calendarUrl);
  if (!cal) throw new Error(`Calendar not found: ${calendarUrl}`);
  const objects = await c.fetchCalendarObjects({
    calendar: cal,
    objectUrls: [objectUrl],
  });
  return objects[0] ?? null;
}

export async function caldavCreateEvent(
  calendarUrl: string,
  filename: string,
  iCalString: string
): Promise<Response> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");
  const calendars = await c.fetchCalendars();
  const cal = calendars.find((x) => x.url === calendarUrl);
  if (!cal) throw new Error(`Calendar not found: ${calendarUrl}`);
  return c.createCalendarObject({
    calendar: cal,
    filename: filename.endsWith(".ics") ? filename : `${filename}.ics`,
    iCalString,
  });
}

export async function caldavUpdateEvent(calendarObject: DAVCalendarObject, iCalString: string): Promise<Response> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");
  return c.updateCalendarObject({
    calendarObject: { ...calendarObject, data: iCalString },
  });
}

export async function caldavDeleteEvent(calendarObject: DAVCalendarObject): Promise<Response> {
  const c = client;
  if (!c) throw new Error("Not connected. Call caldav.connect first.");
  return c.deleteCalendarObject({
    calendarObject,
  });
}

/** Remove an event URL from lastKnownEvents (call after deleting event). */
export function caldavRemoveFromLastKnown(objectUrl: string): void {
  lastKnownEvents.delete(objectUrl);
  if (currentAccount) {
    saveLastEvents(currentAccount, Object.fromEntries(lastKnownEvents));
  }
}

/** Parse UID from ICS data. Exported for delete_event cleanup. */
export function parseIcsEventUid(icsData: string): string | undefined {
  return parseIcsEvent(icsData).uid;
}
