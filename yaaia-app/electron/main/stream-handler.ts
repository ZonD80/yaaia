/**
 * Raw model stream handler: parse bus_id:content, write to DB, emit to GUI.
 * No cuts at ```. Stream as-is. Update message content in DB as it streams.
 */

import {
  ROOT_BUS_ID,
  appendStreamingPlaceholder,
  updateMessageContent,
  setStreamingEnd,
  ensureBus,
  isValidBusId,
} from "./message-db.js";
import { deliverMessage } from "./message-delivery.js";

/** Regex: line starting with bus_id: or bus_id:wait: */
const PREFIX_RE = /^([a-zA-Z0-9_-]+):(wait:)?(.*)$/;

export type StreamHandlerCallbacks = {
  emitChunk: (chunk: string) => void;
};

export type StreamedMessage = {
  busId: string;
  messageId: string;
  /** SQLite messages.id for this assistant row (streaming placeholder). */
  db_id: number;
  content: string;
  streamingStart: string;
  streamingEnd: string;
};

/**
 * Handles raw model stream: parses bus_id:content, writes to DB, emits to GUI.
 * Returns { processChunk, flush, getStreamedMessages }.
 */
export function createStreamHandler(callbacks: StreamHandlerCallbacks): {
  processChunk: (chunk: string) => void;
  flush: () => void;
  getStreamedMessages: () => StreamedMessage[];
} {
  const { emitChunk } = callbacks;
  let buffer = "";
  let current: {
    busId: string;
    messageId: string;
    db_id: number;
    parts: string[];
    streamingStart: string;
  } | null = null;
  const streamedMessages: StreamedMessage[] = [];

  function startMessage(busId: string): void {
    if (!isValidBusId(busId)) return;
    ensureBus(busId);
    const { messageId, streamingStart, db_id } = appendStreamingPlaceholder(busId);
    current = {
      busId,
      messageId,
      db_id,
      parts: [],
      streamingStart,
    };
  }

  function appendToCurrent(part: string): void {
    if (current) current.parts.push(part);
  }

  function finalizeCurrent(): void {
    if (!current) return;
    const content = current.parts.join("\n").trim().replace(/\\n/g, "\n");
    if (content) {
      const storedContent = `${current.busId}:${content}`;
      updateMessageContent(current.busId, current.messageId, storedContent);
      setStreamingEnd(current.busId, current.messageId);
      const streamingEnd = new Date().toISOString();
      streamedMessages.push({
        busId: current.busId,
        messageId: current.messageId,
        db_id: current.db_id,
        content: storedContent,
        streamingStart: current.streamingStart,
        streamingEnd,
      });
      deliverMessage(current.busId, storedContent).catch((err) =>
        console.warn("[YAAIA stream-handler] Delivery failed:", err)
      );
    }
    current = null;
  }

  function processChunk(chunk: string): void {
    if (!chunk) return;
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const m = line.match(PREFIX_RE);
      if (m) {
        const [, busId, , rest] = m;
        if (busId && isValidBusId(busId)) {
          if (current) finalizeCurrent();
          startMessage(busId);
          if (rest) appendToCurrent(rest);
          emitChunk(line + "\n");
        } else if (current) {
          appendToCurrent(line);
          const fullContent = current.parts.join("\n").trim().replace(/\\n/g, "\n");
          if (fullContent) {
            const storedContent = `${current.busId}:${fullContent}`;
            updateMessageContent(current.busId, current.messageId, storedContent);
          }
          emitChunk(line + "\n");
        } else {
          startMessage(ROOT_BUS_ID);
          appendToCurrent(line);
          const storedContent = `${ROOT_BUS_ID}:${line}`;
          updateMessageContent(ROOT_BUS_ID, current!.messageId, storedContent);
          emitChunk(storedContent + "\n");
        }
      } else if (current) {
        appendToCurrent(line);
        const fullContent = current.parts.join("\n").trim().replace(/\\n/g, "\n");
        if (fullContent) {
          const storedContent = `${current.busId}:${fullContent}`;
          updateMessageContent(current.busId, current.messageId, storedContent);
        }
        emitChunk(line + "\n");
      } else {
        startMessage(ROOT_BUS_ID);
        appendToCurrent(line);
        const storedContent = `${ROOT_BUS_ID}:${line}`;
        updateMessageContent(ROOT_BUS_ID, current!.messageId, storedContent);
        emitChunk(storedContent + "\n");
      }
    }
  }

  function flush(): void {
    // Process any remaining buffer (stream may end without trailing newline)
    if (buffer.trim()) {
      processChunk("\n");
    }
    if (current) {
      const raw = (current.parts.join("\n") + "\n" + buffer).trim();
      const content = raw.replace(/\\n/g, "\n");
      if (content && isValidBusId(current.busId)) {
        const storedContent = `${current.busId}:${content}`;
        updateMessageContent(current.busId, current.messageId, storedContent);
        setStreamingEnd(current.busId, current.messageId);
        const streamingEnd = new Date().toISOString();
        streamedMessages.push({
          busId: current.busId,
          messageId: current.messageId,
          db_id: current.db_id,
          content: storedContent,
          streamingStart: current.streamingStart,
          streamingEnd,
        });
        deliverMessage(current.busId, storedContent).catch((err) =>
          console.warn("[YAAIA stream-handler] Delivery failed:", err)
        );
        emitChunk(storedContent + "\n");
      }
    }
    buffer = "";
    current = null;
  }

  function getStreamedMessages(): StreamedMessage[] {
    return [...streamedMessages];
  }

  return { processChunk, flush, getStreamedMessages };
}

/** Parse full text into bus_id:content messages. */
export function parsePrefixedMessages(text: string): { busId: string; content: string; waitForAnswer: boolean }[] {
  const result: { busId: string; content: string; waitForAnswer: boolean }[] = [];
  const lines = text.split("\n");
  let current: { busId: string; waitForAnswer: boolean; parts: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(PREFIX_RE);
    if (m) {
      const [, busId, waitPart, rest] = m;
      const bid = busId ?? "";
      if (isValidBusId(bid)) {
        // Real bus prefix (root, telegram-X, etc.) — start new message
        if (current) {
          const raw = current.parts.join("\n").trim();
          const content = raw.replace(/\\n/g, "\n");
          if (content && isValidBusId(current.busId)) {
            result.push({
              busId: current.busId,
              content,
              waitForAnswer: current.waitForAnswer,
            });
          }
        }
        current = {
          busId: bid,
          waitForAnswer: !!waitPart,
          parts: rest ? [rest] : [],
        };
      } else if (current) {
        // Looks like prefix but not a valid bus (e.g. PATH=..., alias...) — treat as content
        current.parts.push(line);
      }
    } else if (current) {
      current.parts.push(line);
    }
  }
  if (current) {
    const raw = current.parts.join("\n").trim();
    const content = raw.replace(/\\n/g, "\n");
    if (content && isValidBusId(current.busId)) {
      result.push({
        busId: current.busId,
        content,
        waitForAnswer: current.waitForAnswer,
      });
    }
  }
  return result;
}
