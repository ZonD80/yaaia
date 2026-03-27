/**
 * Telegram via local yaaia-tg-gateway (gogram MTProto). No mtcute / Node MTProto.
 * Start gateway: `yaaia-tg-gateway` (see yaaia-telegram-gateway/) or set YAAIA_TG_GATEWAY_URL.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";

const YAAIA_DIR = join(homedir(), "yaaia");
/** gogram session file — not compatible with legacy mtcute storage. */
export const TELEGRAM_SESSION_PATH = join(YAAIA_DIR, "telegram-gogram.session");
const TELEGRAM_CONNECT_STATE_PATH = join(YAAIA_DIR, "telegram-connect-state.json");

function gatewayBase(): string {
  return (process.env.YAAIA_TG_GATEWAY_URL ?? "http://127.0.0.1:37567").replace(/\/$/, "");
}

function gatewayHeaders(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = process.env.YAAIA_TG_GATEWAY_TOKEN?.trim();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function gw(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${gatewayBase()}${path}`, {
    ...init,
    headers: { ...gatewayHeaders(), ...(init?.headers as Record<string, string>) },
  });
}

export function saveTelegramConnectPhone(phone: string): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(TELEGRAM_CONNECT_STATE_PATH, JSON.stringify({ phone: phone.trim() }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[YAAIA Telegram] Failed to save connect phone:", err);
  }
}

export function loadTelegramConnectPhone(): string | null {
  try {
    if (existsSync(TELEGRAM_CONNECT_STATE_PATH)) {
      const raw = JSON.parse(readFileSync(TELEGRAM_CONNECT_STATE_PATH, "utf-8"));
      const phone = typeof raw?.phone === "string" ? raw.phone.trim() : null;
      return phone && phone.length > 0 ? phone : null;
    }
  } catch (err) {
    console.warn("[YAAIA Telegram] Failed to load connect phone:", err);
  }
  return null;
}

export type MissedMessagePayload = {
  bus_id: string;
  user_id: number;
  user_name: string;
  content: string;
  timestamp?: string;
  message_id?: number;
};

export type TelegramConnectParams = {
  apiId: number;
  apiHash: string;
  phone: string;
  getLoginInput?: (step: "code" | "password") => Promise<string>;
};

export type OnTelegramMessageCallback = (
  payload: {
    bus_id: string;
    user_id: number;
    user_name: string;
    content: string;
    timestamp?: string;
    message_id?: number;
  },
  opts?: { deliverToModel?: boolean }
) => void;

let onMessageCallback: OnTelegramMessageCallback | null = null;
let sseAbort: AbortController | null = null;
let connectedFlag = false;

/** Undici defaults ~300s body timeout — idle SSE hits BodyTimeoutError. Disable for long-lived streams. */
const sseDispatcher = new Agent({
  connections: 1,
  bodyTimeout: 0,
  headersTimeout: 0,
});

export function setOnTelegramMessage(cb: OnTelegramMessageCallback | null): void {
  onMessageCallback = cb;
}

/** Legacy VoIP hook — always null (MTProto lives in Go gateway). */
export function getTelegramClient(): null {
  return null;
}

export function isTelegramConnected(): boolean {
  return connectedFlag;
}

export async function telegramRpcCall(): Promise<never> {
  throw new Error("telegramRpcCall removed — use yaaia-tg-gateway (Go) for raw RPC");
}

export async function telegramConnect(params: TelegramConnectParams): Promise<boolean> {
  const { apiId, apiHash, phone, getLoginInput } = params;
  if (!apiId || !apiHash?.trim() || !phone?.trim()) {
    return false;
  }
  await telegramDisconnect(false);
  try {
    const health = await gw("/v1/health");
    if (!health.ok) {
      throw new Error(
        `Telegram gateway not reachable at ${gatewayBase()}. Run: yaaia-tg-gateway (see yaaia-telegram-gateway/)`
      );
    }
    mkdirSync(YAAIA_DIR, { recursive: true });
    const sessionRes = await gw("/v1/session", {
      method: "POST",
      body: JSON.stringify({
        api_id: apiId,
        api_hash: apiHash.trim(),
        session_path: TELEGRAM_SESSION_PATH,
      }),
    });
    if (!sessionRes.ok) {
      const t = await sessionRes.text();
      throw new Error(t || "session failed");
    }
    const st = await gw("/v1/status");
    const stJson = (await st.json()) as { authorized?: boolean };
    if (!stJson.authorized) {
      const send = await gw("/v1/login/send-code", {
        method: "POST",
        body: JSON.stringify({ phone: phone.trim() }),
      });
      if (!send.ok) {
        const t = await send.text();
        throw new Error(t || "send-code failed");
      }
      const { code_hash: codeHash } = (await send.json()) as { code_hash: string };
      const code = getLoginInput ? await getLoginInput("code") : "";
      if (!code?.trim()) throw new Error("login code required");
      let loginBody: Record<string, string> = {
        phone: phone.trim(),
        code: code.trim(),
        code_hash: codeHash,
      };
      let login = await gw("/v1/login", { method: "POST", body: JSON.stringify(loginBody) });
      if (!login.ok) {
        const errText = await login.text();
        if (errText.toLowerCase().includes("password") && getLoginInput) {
          const pwd = await getLoginInput("password");
          loginBody = { ...loginBody, password: pwd.trim() };
          login = await gw("/v1/login", { method: "POST", body: JSON.stringify(loginBody) });
        }
        if (!login.ok) {
          throw new Error((await login.text()) || "login failed");
        }
      }
    }
    connectedFlag = true;
    startSseLoop();
    return true;
  } catch (err) {
    console.error("[YAAIA Telegram] Connect failed:", err);
    connectedFlag = false;
    throw err;
  }
}

function startSseLoop(): void {
  sseAbort?.abort();
  sseAbort = new AbortController();
  const ctrl = sseAbort;
  void pumpTelegramSse(ctrl);
}

async function pumpTelegramSse(ctrl: AbortController): Promise<void> {
  try {
    const res = await undiciFetch(`${gatewayBase()}/v1/events`, {
      headers: gatewayHeaders(),
      signal: ctrl.signal,
      dispatcher: sseDispatcher,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const json = line.slice("data: ".length);
        try {
          const ev = JSON.parse(json) as { type?: string; data?: unknown };
          if (ev.type === "telegram_message" && ev.data && typeof ev.data === "object") {
            const d = ev.data as Record<string, unknown>;
            onMessageCallback?.({
              bus_id: String(d.bus_id ?? ""),
              user_id: Number(d.user_id ?? 0),
              user_name: String(d.user_name ?? ""),
              content: String(d.content ?? ""),
              timestamp: typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString(),
              message_id: d.message_id != null ? Number(d.message_id) : undefined,
            });
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    console.warn("[YAAIA Telegram] SSE ended:", e);
  }
  if (!connectedFlag || ctrl.signal.aborted || ctrl !== sseAbort) return;
  await new Promise((r) => setTimeout(r, 1500));
  if (!connectedFlag || ctrl.signal.aborted || ctrl !== sseAbort) return;
  await pumpTelegramSse(ctrl);
}

export async function telegramDisconnect(clearReconnectParams = true): Promise<void> {
  void clearReconnectParams;
  sseAbort?.abort();
  sseAbort = null;
  connectedFlag = false;
  try {
    await gw("/v1/disconnect", { method: "POST", body: "{}" });
  } catch {
    /* ignore */
  }
}

export async function telegramFetchMissedMessages(opts?: { deliverToModel?: boolean }): Promise<MissedMessagePayload[]> {
  const r = await gw("/v1/messages/missed", {
    method: "POST",
    body: JSON.stringify({ max_dialogs: 200, per_peer_limit: 100 }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.warn("[YAAIA Telegram] missed messages:", t || r.status);
    return [];
  }
  const j = (await r.json()) as { messages?: unknown[] };
  const raw = Array.isArray(j.messages) ? j.messages : [];
  const out: MissedMessagePayload[] = [];
  const deliver = opts?.deliverToModel ?? false;
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const d = row as Record<string, unknown>;
    const payload: MissedMessagePayload = {
      bus_id: String(d.bus_id ?? ""),
      user_id: Number(d.user_id ?? 0),
      user_name: String(d.user_name ?? ""),
      content: String(d.content ?? ""),
      timestamp: typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString(),
      message_id: d.message_id != null ? Number(d.message_id) : undefined,
    };
    if (!payload.bus_id || !payload.content) continue;
    out.push(payload);
    onMessageCallback?.(payload, { deliverToModel: deliver });
  }
  return out;
}

export async function telegramResolvePeer(username: string): Promise<{ bus_id: string; display_name?: string }> {
  const u = encodeURIComponent(username.startsWith("@") ? username.slice(1) : username);
  const r = await gw(`/v1/resolve?username=${u}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || "resolve failed");
  }
  const j = (await r.json()) as { bus_id?: string; peer_id?: number };
  return { bus_id: j.bus_id ?? "", display_name: username };
}

export async function telegramSendText(peerId: number, text: string): Promise<void> {
  const r = await gw("/v1/send", {
    method: "POST",
    body: JSON.stringify({ peer_id: peerId, text }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || "send failed");
  }
}

export async function telegramSendTyping(peerId: number): Promise<void> {
  await gw("/v1/typing", {
    method: "POST",
    body: JSON.stringify({ peer_id: peerId }),
  }).catch(() => {});
}

export async function telegramDeleteChatHistory(peerId: number): Promise<void> {
  const r = await gw("/v1/delete-history", {
    method: "POST",
    body: JSON.stringify({ peer_id: peerId }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || "delete-history failed");
  }
}

export function telegramBusIdForUserId(userId: number): string {
  return `telegram-${userId}`;
}

export function parseTelegramBusPeerId(busId: string): number | null {
  if (!busId.startsWith("telegram-")) return null;
  const n = parseInt(busId.slice("telegram-".length), 10);
  return Number.isFinite(n) ? n : null;
}
