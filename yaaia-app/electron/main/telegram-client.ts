/**
 * Telegram client wrapper using mtcute. User account (not bot).
 * Connects when chat starts, disconnects when chat stops.
 */

import { TelegramClient } from "@mtcute/node";
import { sendText, sendTyping } from "@mtcute/core/methods.js";
import { md } from "@mtcute/markdown-parser";
import { getPeer } from "@mtcute/core/methods.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "@mtcute/core";

let client: TelegramClient | null = null;

const YAAIA_DIR = join(homedir(), "yaaia");
const TELEGRAM_STORAGE = join(YAAIA_DIR, "telegram-session");

export type TelegramConnectParams = {
  apiId: number;
  apiHash: string;
  phone: string;
  /** When login requires code or 2FA, called to get from user. */
  getLoginInput?: (step: "code" | "password") => Promise<string>;
};

export type OnTelegramMessageCallback = (payload: {
  bus_id: string;
  user_id: number;
  user_name: string;
  content: string;
}) => void;

let onMessageCallback: OnTelegramMessageCallback | null = null;
let messageHandlerUnsub: (() => void) | undefined;

export function setOnTelegramMessage(cb: OnTelegramMessageCallback | null): void {
  onMessageCallback = cb;
}

export function isTelegramConnected(): boolean {
  return client !== null;
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
  await telegramDisconnect();
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
      const unsub = (client.onNewMessage as { add: (fn: (msg: Message) => void) => () => void }).add(handleNewMessage);
      console.log("[YAAIA Telegram] Message handler registered (onNewMessage.add)");
      messageHandlerUnsub = typeof unsub === "function" ? unsub : undefined;
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
  console.log("[YAAIA Telegram] Delivering message to bus:", busId, "from", userName);
  onMessageCallback?.({
    bus_id: busId,
    user_id: userId,
    user_name: userName,
    content,
  });
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
  let input: string | { text: string; entities?: unknown[] };
  try {
    input = md(text);
  } catch {
    input = text;
  }
  await sendText(tg, peerId, input);
}

export async function telegramSendTyping(peerId: number): Promise<void> {
  try {
    const tg = getClient();
    await sendTyping(tg, peerId, "typing");
  } catch (err) {
    console.warn("[YAAIA Telegram] sendTyping failed:", err);
  }
}

export async function telegramDisconnect(): Promise<void> {
  if (client) {
    try {
      messageHandlerUnsub?.();
      messageHandlerUnsub = undefined;
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
