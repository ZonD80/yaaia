/**
 * Immediate delivery when outbound messages are persisted to DB.
 * root → GUI, telegram-* → Telegram API.
 */

import { ROOT_BUS_ID } from "./message-db.js";
import { telegramSendText } from "./telegram-client.js";
import * as recipeStore from "./recipe-store.js";

export type DeliveryCallbacks = {
  onSendToRoot?: (content: string) => void;
};

let callbacks: DeliveryCallbacks = {};

export function setDeliveryCallbacks(cb: DeliveryCallbacks): void {
  callbacks = cb;
}

/** Extract content from stored format (bus_id:content). */
function extractContent(busId: string, storedContent: string): string {
  const prefix = `${busId}:`;
  if (storedContent.startsWith(prefix)) {
    return storedContent.slice(prefix.length).trimStart();
  }
  return storedContent;
}

/**
 * Deliver an outbound message immediately.
 * Called after appending assistant or during_eval messages to DB.
 */
export async function deliverMessage(busId: string, storedContent: string): Promise<{ ok: boolean; error?: string }> {
  const content = extractContent(busId, storedContent);

  if (busId === ROOT_BUS_ID) {
    callbacks.onSendToRoot?.(storedContent);
    return { ok: true };
  }

  if (busId.startsWith("telegram-")) {
    try {
      const peerId = parseInt(busId.replace("telegram-", ""), 10);
      if (!isNaN(peerId)) {
        await telegramSendText(peerId, content);
      }
      recipeStore.appendToolCall("send_message", { bus_id: busId, content }, `[${busId}] ${content}`);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      recipeStore.appendToolCall("send_message", { bus_id: busId, content }, m);
      return { ok: false, error: m };
    }
  }

  recipeStore.appendToolCall("send_message", { bus_id: busId, content }, `[${busId}] ${content}`);
  return { ok: true };
}
