/**
 * Telegram client wrapper using mtcute. User account (not bot).
 * Connects when chat starts, disconnects when chat stops.
 * Auto-reconnects on connection loss (like mail client).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { TelegramClient } from "@mtcute/node";
import { sendText, sendTyping, readHistory, iterDialogs, searchMessages, deleteHistory } from "@mtcute/core/methods.js";
import { md } from "@mtcute/markdown-parser";
import { getPeer } from "@mtcute/core/methods.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "@mtcute/core";

let client: TelegramClient | null = null;
let storedReconnectParams: TelegramConnectParams | null = null;
let reconnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let connectionStateUnsub: (() => void) | undefined;
let errorUnsub: (() => void) | undefined;

const RECONNECT_DELAY_MS = 5_000;
const CONNECTION_CHECK_INTERVAL_MS = 60_000;
let connectionCheckInterval: ReturnType<typeof setInterval> | null = null;

const YAAIA_DIR = join(homedir(), "yaaia");
const TELEGRAM_STORAGE = join(YAAIA_DIR, "telegram-session");
const TELEGRAM_LAST_SEEN_PATH = join(YAAIA_DIR, "telegram-last-seen.json");

export type MissedMessagePayload = { bus_id: string; user_id: number; user_name: string; content: string; timestamp?: string };

function loadLastReceivedTimestamp(): number {
  try {
    if (existsSync(TELEGRAM_LAST_SEEN_PATH)) {
      const raw = JSON.parse(readFileSync(TELEGRAM_LAST_SEEN_PATH, "utf-8"));
      const ts = typeof raw?.lastReceivedMessageDate === "number" ? raw.lastReceivedMessageDate : 0;
      return ts > 0 ? ts : 0;
    }
  } catch (err) {
    console.warn("[YAAIA Telegram] Failed to load last-seen:", err);
  }
  return 0;
}

function saveLastReceivedTimestamp(date: number): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(TELEGRAM_LAST_SEEN_PATH, JSON.stringify({ lastReceivedMessageDate: date }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[YAAIA Telegram] Failed to save last-seen:", err);
  }
}

export type TelegramConnectParams = {
  apiId: number;
  apiHash: string;
  phone: string;
  /** When login requires code or 2FA, called to get from user. */
  getLoginInput?: (step: "code" | "password") => Promise<string>;
};

export type OnTelegramMessageCallback = (
  payload: {
    bus_id: string;
    user_id: number;
    user_name: string;
    content: string;
    /** ISO timestamp of the message; used for history file path */
    timestamp?: string;
  },
  opts?: { deliverToModel?: boolean }
) => void;

let onMessageCallback: OnTelegramMessageCallback | null = null;
let messageHandlerUnsub: (() => void) | undefined;
/** Client instance the handler was registered on, used to explicitly remove it on disconnect. */
let messageHandlerClient: TelegramClient | null = null;

/** Dedupe by (chatId|msgId). Guards against fetchMissedMessages + handleNewMessage delivering same msg. */
const deliveredMessageIds = new Set<string>();
const MAX_DELIVERED_IDS = 5000;

/**
 * Secondary dedup by content+timestamp. Guards against mtcute firing onNewMessage twice for the
 * same physical message with different IDs (e.g. temp ID on arrival vs confirmed server ID, or
 * catch-up updates after reconnect overlapping with live updates).
 * Key: chatId|content_prefix|msgDateUnix  Value: delivery timestamp (ms)
 */
const deliveredContentKeys = new Map<string, number>();
const CONTENT_DEDUP_WINDOW_MS = 10_000;

function markDelivered(chatId: number, msgId: number, content?: string, msgDateUnix?: number): boolean {
  const key = `${chatId}|${msgId}`;
  if (deliveredMessageIds.has(key)) return false;

  if (content !== undefined && msgDateUnix !== undefined) {
    const contentKey = `${chatId}|${content.slice(0, 100)}|${msgDateUnix}`;
    const now = Date.now();
    if (deliveredContentKeys.has(contentKey)) {
      console.log("[YAAIA Telegram] Skipping content-dedup duplicate:", key);
      // Still register the ID so future ID-based checks also catch it
      deliveredMessageIds.add(key);
      return false;
    }
    deliveredContentKeys.set(contentKey, now);
    // Prune old entries
    for (const [k, ts] of deliveredContentKeys) {
      if (now - ts > CONTENT_DEDUP_WINDOW_MS) deliveredContentKeys.delete(k);
    }
  }

  deliveredMessageIds.add(key);
  if (deliveredMessageIds.size > MAX_DELIVERED_IDS) {
    const arr = [...deliveredMessageIds];
    deliveredMessageIds.clear();
    arr.slice(-Math.floor(MAX_DELIVERED_IDS * 0.8)).forEach((k) => deliveredMessageIds.add(k));
  }
  return true;
}

export function setOnTelegramMessage(cb: OnTelegramMessageCallback | null): void {
  onMessageCallback = cb;
}

export function isTelegramConnected(): boolean {
  const c = client;
  if (!c) return false;
  const connected = (c as { isConnected?: boolean }).isConnected;
  return connected !== false;
}

function scheduleReconnect(): void {
  if (reconnectTimeoutHandle) return;
  if (!storedReconnectParams) return;
  console.log("[YAAIA Telegram] Scheduling reconnect in", RECONNECT_DELAY_MS, "ms");
  reconnectTimeoutHandle = setTimeout(async () => {
    reconnectTimeoutHandle = null;
    const params = storedReconnectParams;
    if (!params) return;
    try {
      console.log("[YAAIA Telegram] Attempting reconnect...");
      const ok = await telegramConnect(params);
      if (ok) {
        const missed = await telegramFetchMissedMessages();
        if (missed.length > 0) {
          console.log("[YAAIA Telegram] Delivered", missed.length, "missed message(s) after reconnect");
        }
      }
    } catch (err) {
      console.warn("[YAAIA Telegram] Reconnect failed:", err instanceof Error ? err.message : err);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

function handleConnectionLost(): void {
  if (client) {
    try {
      messageHandlerUnsub?.();
      messageHandlerUnsub = undefined;
      client.destroy().catch(() => {});
    } catch {
      /* ignore */
    }
    client = null;
  }
  if (connectionCheckInterval) {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = null;
  }
  scheduleReconnect();
}

function setupConnectionListeners(c: TelegramClient): void {
  connectionStateUnsub?.();
  errorUnsub?.();
  if (connectionCheckInterval) {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = null;
  }
  const stateEmitter = c.onConnectionState as unknown as { add: (fn: (state: string) => void) => () => void };
  const errorEmitter = c.onError as unknown as { add: (fn: (err: unknown) => void) => () => void };
  if (stateEmitter?.add) {
    connectionStateUnsub = stateEmitter.add((state: string) => {
      if (state === "offline") {
        console.warn("[YAAIA Telegram] Connection state: offline");
        handleConnectionLost();
      }
    });
  }
  if (errorEmitter?.add) {
    errorUnsub = errorEmitter.add((err: unknown) => {
      console.error("[YAAIA Telegram] Connection error:", err instanceof Error ? err.message : err);
      handleConnectionLost();
    });
  }
  connectionCheckInterval = setInterval(() => {
    const c = client;
    if (!c || !storedReconnectParams) return;
    const isConnected = (c as { isConnected?: boolean }).isConnected;
    if (isConnected === false) {
      console.warn("[YAAIA Telegram] Periodic check: connection lost");
      handleConnectionLost();
    }
  }, CONNECTION_CHECK_INTERVAL_MS);
}

function getClient(): TelegramClient {
  if (!client) throw new Error("Telegram not connected. Configure apiId/apiHash and complete login.");
  return client;
}

export async function telegramConnect(params: TelegramConnectParams): Promise<boolean> {
  const { apiId, apiHash, phone, getLoginInput } = params;
  if (!apiId || !apiHash?.trim() || !phone?.trim()) {
    return false;
  }
  await telegramDisconnect(false);
  try {
    client = new TelegramClient({
      apiId,
      apiHash: apiHash.trim(),
      storage: TELEGRAM_STORAGE,
    });
    const startParams = getLoginInput
      ? {
          phone: phone.trim(),
          code: () => getLoginInput("code"),
          password: () => getLoginInput("password"),
        }
      : { phone: phone.trim() };
    const self = await client.start(startParams as never);
    if (self) {
      console.log("[YAAIA Telegram] Connected. Logged in as", self.displayName ?? self.id);
      storedReconnectParams = { apiId, apiHash, phone, getLoginInput };
      setupConnectionListeners(client);
      const dispatcher = client.onNewMessage as unknown as { add: (fn: (msg: Message) => void) => () => void; remove: (fn: (msg: Message) => void) => void };
      const unsub = dispatcher.add(handleNewMessage);
      messageHandlerClient = client;
      // Prefer the returned unsubscribe fn; fall back to explicit .remove() call on the stored client ref.
      messageHandlerUnsub = typeof unsub === "function" ? unsub : () => {
        try { dispatcher.remove(handleNewMessage); } catch { /* ignore */ }
      };
      console.log("[YAAIA Telegram] Message handler registered (onNewMessage.add)");
      return true;
    }
  } catch (err) {
    console.error("[YAAIA Telegram] Connect failed:", err);
    client = null;
    throw err;
  }
  return false;
}

async function handleNewMessage(msg: Message): Promise<void> {
  console.log("[YAAIA Telegram] onNewMessage fired:", {
    isOutgoing: msg.isOutgoing,
    hasText: !!msg.text?.trim(),
    chatId: msg.chat?.id,
    senderType: msg.sender?.type,
  });
  if (msg.isOutgoing) return;
  if (!msg.text?.trim()) return;
  const chat = msg.chat;
  const sender = msg.sender;
  const chatId = chat.id;
  const busId = `telegram-${chatId}`;
  const userId = sender.type === "user" ? sender.id : 0;
  const userName = sender.type === "user" ? (sender.username ?? sender.displayName ?? String(userId)) : "unknown";
  const content = msg.text.trim();
  const timestamp = msg.date instanceof Date ? msg.date.toISOString() : undefined;
  const msgDateUnix = msg.date instanceof Date ? Math.floor(msg.date.getTime() / 1000) : Math.floor(Date.now() / 1000);
  if (!markDelivered(chatId, msg.id, content, msgDateUnix)) {
    console.log("[YAAIA Telegram] Skipping duplicate message:", busId, msg.id);
    return;
  }
  console.log("[YAAIA Telegram] Delivering message to bus:", busId, "from", userName);
  onMessageCallback?.({
    bus_id: busId,
    user_id: userId,
    user_name: userName,
    content,
    timestamp,
  });
  if (client) {
    try {
      await readHistory(client, msg.chat.id, { maxId: msg.id });
    } catch (err) {
      console.warn("[YAAIA Telegram] readHistory failed:", err instanceof Error ? err.message : err);
    }
  }
  const msgDate = msg.date instanceof Date ? Math.floor(msg.date.getTime() / 1000) : Math.floor(Date.now() / 1000);
  saveLastReceivedTimestamp(msgDate);
}

/** Fetch messages since last received timestamp, deliver to callback, update timestamp. Returns list of delivered payloads.
 * @param opts.deliverToModel - when false, only append to bus history (no renderer). Use when agent gets result in tool (e.g. telegram_connect). Default true for reconnect. */
export async function telegramFetchMissedMessages(opts?: { deliverToModel?: boolean }): Promise<MissedMessagePayload[]> {
  const tg = client;
  if (!tg) return [];
  const since = loadLastReceivedTimestamp();
  if (since <= 0) return [];
  const all: { msg: Message; date: number }[] = [];
  try {
    for await (const dialog of iterDialogs(tg, { limit: 50 })) {
      const d = dialog as { peer?: { inputPeer?: unknown } };
      if (!d.peer?.inputPeer) continue;
      try {
        const res = await searchMessages(tg, {
          chatId: d.peer as Parameters<typeof searchMessages>[1] extends { chatId?: infer C } ? C : never,
          minDate: since,
          limit: 100,
        });
        const msgs = Array.isArray(res) ? res : [];
        for (const m of msgs) {
          const msg = m as Message;
          if (msg.isOutgoing) continue;
          const text = msg.text?.trim();
          if (!text) continue;
          const date = msg.date instanceof Date ? Math.floor(msg.date.getTime() / 1000) : 0;
          all.push({ msg, date });
        }
      } catch (err) {
        console.warn("[YAAIA Telegram] searchMessages for dialog failed:", err);
      }
    }
  } catch (err) {
    console.warn("[YAAIA Telegram] iterDialogs failed:", err);
    return [];
  }
  all.sort((a, b) => a.date - b.date);
  const delivered: MissedMessagePayload[] = [];
  let maxDate = since;
  for (const { msg, date } of all) {
    if (date <= since) continue; /* skip last message we already received (minDate is inclusive) */
    const chat = msg.chat;
    const sender = msg.sender;
    const chatId = chat.id;
    if (!markDelivered(chatId, msg.id)) continue; /* skip if handleNewMessage already delivered (e.g. on reconnect catch-up) */
    const busId = `telegram-${chatId}`;
    const userId = sender.type === "user" ? sender.id : 0;
    const userName = sender.type === "user" ? (sender.username ?? sender.displayName ?? String(userId)) : "unknown";
    const content = msg.text?.trim() ?? "";
    const timestamp = msg.date instanceof Date ? msg.date.toISOString() : undefined;
    delivered.push({ bus_id: busId, user_id: userId, user_name: userName, content, timestamp });
    onMessageCallback?.({ bus_id: busId, user_id: userId, user_name: userName, content, timestamp }, opts);
    if (date > maxDate) maxDate = date;
  }
  if (maxDate > since) saveLastReceivedTimestamp(maxDate);
  return delivered;
}

export async function telegramResolvePeer(username: string): Promise<{ bus_id: string; display_name?: string }> {
  const tg = getClient();
  const normalized = username.startsWith("@") ? username.slice(1) : username;
  if (!normalized.trim()) {
    throw new Error("Username is required (e.g. durov or @durov)");
  }
  const peer = await getPeer(tg, normalized);
  const busId = `telegram-${peer.id}`;
  const displayName =
    peer.type === "user"
      ? (peer as { displayName?: string; username?: string }).displayName ??
        (peer as { username?: string }).username ??
        normalized
      : (peer as { title?: string }).title ?? normalized;
  return { bus_id: busId, display_name: displayName };
}

export async function telegramSendText(peerId: number, text: string): Promise<void> {
  const tg = getClient();
  let input: string | ReturnType<typeof md>;
  try {
    input = md(text);
  } catch {
    input = text;
  }
  await sendText(tg, peerId, input as Parameters<typeof sendText>[2]);
}

export async function telegramSendTyping(peerId: number): Promise<void> {
  try {
    const tg = getClient();
    await sendTyping(tg, peerId, "typing");
  } catch (err) {
    console.warn("[YAAIA Telegram] sendTyping failed:", err);
  }
}

/** Delete chat history from Telegram (for private chats and legacy groups). Requires Telegram to be connected. */
export async function telegramDeleteChatHistory(peerId: number): Promise<void> {
  const tg = getClient();
  await deleteHistory(tg, peerId, { mode: "delete" });
}

/** @param clearReconnectParams - when true (default), clear stored params. Pass false when disconnecting as part of reconnect. */
export async function telegramDisconnect(clearReconnectParams = true): Promise<void> {
  if (reconnectTimeoutHandle) {
    clearTimeout(reconnectTimeoutHandle);
    reconnectTimeoutHandle = null;
  }
  if (connectionCheckInterval) {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = null;
  }
  if (clearReconnectParams) storedReconnectParams = null;
  connectionStateUnsub?.();
  connectionStateUnsub = undefined;
  errorUnsub?.();
  errorUnsub = undefined;
  if (client) {
    try {
      messageHandlerUnsub?.();
      messageHandlerUnsub = undefined;
      messageHandlerClient = null;
      await client.destroy();
    } catch (err) {
      console.warn("[YAAIA Telegram] Disconnect error:", err);
    }
    client = null;
  }
  // Do NOT clear onMessageCallback here. It is cleared by the main process when
  // stopping the chat. telegramConnect calls us before reconnecting, and clearing
  // would drop incoming messages after reconnect.
}
