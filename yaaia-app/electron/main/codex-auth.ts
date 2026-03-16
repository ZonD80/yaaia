/**
 * Codex OAuth authentication for ChatGPT Plus/Pro (Codex) subscription.
 * Uses OpenAI's official OAuth flow (same as openai/codex CLI and opencode-openai-codex-auth).
 *
 * For personal development use with your own ChatGPT Plus/Pro subscription.
 * For production, use the OpenAI Platform API.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const YAAIA_DIR = join(homedir(), "yaaia");
const CODEX_AUTH_PATH = join(YAAIA_DIR, "codex-auth.json");

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexTokens {
  access: string;
  refresh: string;
  expires: number;
}

export interface CodexAuthState {
  access: string;
  refresh: string;
  expires: number;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

export function loadCodexAuth(): CodexAuthState | null {
  try {
    if (existsSync(CODEX_AUTH_PATH)) {
      const data = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8")) as CodexAuthState;
      if (data.access && data.refresh && typeof data.expires === "number") {
        return data;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveCodexAuth(tokens: CodexTokens): void {
  mkdirSync(YAAIA_DIR, { recursive: true });
  writeFileSync(CODEX_AUTH_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export function clearCodexAuth(): void {
  try {
    if (existsSync(CODEX_AUTH_PATH)) {
      writeFileSync(CODEX_AUTH_PATH, "{}", "utf-8");
    }
  } catch {
    /* ignore */
  }
}

export function decodeJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getCodexAccountId(): string | null {
  const auth = loadCodexAuth();
  if (!auth?.access) return null;
  const decoded = decodeJWT(auth.access);
  if (!decoded) return null;
  const claim = decoded[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
  return claim?.chatgpt_account_id ?? null;
}

export function isCodexTokenExpired(): boolean {
  const auth = loadCodexAuth();
  if (!auth) return true;
  return auth.expires < Date.now();
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri = REDIRECT_URI
): Promise<{ ok: true; tokens: CodexTokens } | { ok: false; error: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Token exchange failed: ${res.status} ${text}` };
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    return { ok: false, error: "Token response missing required fields" };
  }
  const tokens: CodexTokens = {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
  saveCodexAuth(tokens);
  return { ok: true, tokens };
}

export async function refreshCodexToken(): Promise<CodexTokens | null> {
  const auth = loadCodexAuth();
  if (!auth?.refresh) return null;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    return null;
  }
  const tokens: CodexTokens = {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
  saveCodexAuth(tokens);
  return tokens;
}

export function createAuthorizationFlow(): { url: string; state: string; verifier: string } {
  const { verifier, challenge } = generatePKCE();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return { url: url.toString(), state, verifier };
}

const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Success</title></head>
<body>
  <h1>Authentication successful</h1>
  <p>You can close this window and return to YAAIA.</p>
</body>
</html>`;

export interface OAuthServerResult {
  close: () => void;
  waitForCode: (state: string) => Promise<{ code: string } | null>;
}

export function startCodexOAuthServer(): Promise<OAuthServerResult> {
  return new Promise((resolve) => {
    let lastCode: string | null = null;
    let lastState: string | null = null;

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== "/auth/callback") {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        lastState = url.searchParams.get("state");
        lastCode = url.searchParams.get("code");
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
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          waitForCode: async (state: string) => {
            for (let i = 0; i < 600; i++) {
              if (lastCode && lastState === state) {
                return { code: lastCode };
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            return null;
          },
        });
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        console.warn("[YAAIA Codex] Failed to bind port 1455:", err?.code);
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
