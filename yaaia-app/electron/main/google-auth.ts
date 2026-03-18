/**
 * Google OAuth 2.0 for Gmail and Calendar APIs.
 * Credentials: hardcoded (same as CalDAV). Tokens stored in ~/yaaia/google-api-auth.json.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";

const _k = "y4a1a";
const _x = (h: string) =>
  Buffer.from(h, "hex").map((b: number, i: number) => b ^ _k.charCodeAt(i % _k.length)).toString();

const GOOGLE_CLIENT_ID = _x("4b0c5009504f005308564b054c501214555556054a5e0a0217185653020d1304575d0441415440090c0d054058575511411257530e5e0615511442040b570e5f151c5a151f021659");
const GOOGLE_CLIENT_SECRET = _x("3e7b22623121190d421418732c7231400d595c0330781046582b640a49353d66237f54");

const YAAIA_DIR = join(homedir(), "yaaia");
const GOOGLE_AUTH_PATH = join(YAAIA_DIR, "google-api-auth.json");
const REDIRECT_URI = "http://localhost:9010/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date: number;
}

function loadTokens(): GoogleTokens | null {
  try {
    if (existsSync(GOOGLE_AUTH_PATH)) {
      const data = JSON.parse(readFileSync(GOOGLE_AUTH_PATH, "utf-8")) as GoogleTokens;
      if (data.access_token && typeof data.expiry_date === "number") {
        return data;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveTokens(tokens: GoogleTokens): void {
  mkdirSync(YAAIA_DIR, { recursive: true });
  writeFileSync(GOOGLE_AUTH_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export function clearGoogleAuth(): void {
  try {
    if (existsSync(GOOGLE_AUTH_PATH)) {
      writeFileSync(GOOGLE_AUTH_PATH, "{}", "utf-8");
    }
  } catch {
    /* ignore */
  }
}

export function isGoogleAuthorized(): boolean {
  const tokens = loadTokens();
  return !!(tokens?.access_token);
}

/** Get OAuth2 client. Returns null if not authorized. */
export async function getGoogleOAuth2Client(): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const tokens = loadTokens();
  if (!tokens?.access_token) return null;

  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on("tokens", (newTokens) => {
    if (newTokens.refresh_token) {
      saveTokens({
        access_token: newTokens.access_token!,
        refresh_token: newTokens.refresh_token,
        expiry_date: newTokens.expiry_date ?? Date.now() + 3600 * 1000,
      });
    } else {
      const current = loadTokens();
      if (current?.refresh_token) {
        saveTokens({
          ...current,
          access_token: newTokens.access_token!,
          expiry_date: newTokens.expiry_date ?? Date.now() + 3600 * 1000,
        });
      }
    }
  });
  return oauth2Client;
}

export interface OAuthCallbackServer {
  close: () => void;
  waitForCode: (state: string) => Promise<{ code: string } | null>;
}

export async function startGoogleOAuthFlow(): Promise<
  | { ok: true; url: string; state: string; server: OAuthCallbackServer }
  | { ok: false; error: string }
> {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  const state = randomBytes(16).toString("hex");
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    prompt: "consent",
  });

  const server = await startCodeCallbackServer();
  return { ok: true, url, state, server };
}

export async function exchangeGoogleCode(code: string): Promise<{ ok: true; tokens: GoogleTokens } | { ok: false; error: string }> {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.access_token) {
      return { ok: false, error: "No access token in response" };
    }
    const stored: GoogleTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
    };
    saveTokens(stored);
    return { ok: true, tokens: stored };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Success</title></head>
<body>
  <h1>Google API authorized</h1>
  <p>You can close this window and return to YAAIA.</p>
</body>
</html>`;

async function startCodeCallbackServer(): Promise<OAuthCallbackServer> {
  return new Promise((resolve) => {
    let lastCode: string | null = null;
    let lastState: string | null = null;

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== "/oauth2callback") {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        lastState = url.searchParams.get("state");
        lastCode = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.statusCode = 400;
          res.end(`Authorization failed: ${error}`);
          return;
        }
        if (!lastCode) {
          res.statusCode = 400;
          res.end("Missing authorization code");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(OAUTH_SUCCESS_HTML);
      } catch {
        res.statusCode = 500;
        res.end("Internal error");
      }
    });

    server
      .listen(9010, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          waitForCode: async (expectedState: string) => {
            for (let i = 0; i < 600; i++) {
              if (lastCode && lastState === expectedState) {
                return { code: lastCode };
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            return null;
          },
        });
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        console.warn("[YAAIA Google] Failed to bind port 9010:", err?.code);
        resolve({
          close: () => {
            try {
              server.close();
            } catch {}
          },
          waitForCode: async () => null,
        });
      });
  });
}
