/**
 * IMAP client wrapper using imapflow. Single connection per session.
 * Uses IDLE for new message detection. Auto-reconnects on failure.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const YAAIA_DIR = join(homedir(), "yaaia");
const SHARED_DIR = join(YAAIA_DIR, "storage", "shared");
const INBOX = "INBOX";

function sanitizeAccountForBusId(user: string): string {
  return user.replace(/@/g, "-").replace(/\./g, "-");
}

/** Extract a human-readable message from imapflow errors (auth, server response, etc.). */
export function formatImapError(err: unknown): string {
  const e = err as Record<string, unknown> | undefined;
  if (!e) return String(err);
  // imapflow logs pass { err: {...} }; thrown errors may have props on err or e.err
  const inner = (e.err as Record<string, unknown>) ?? e;
  const responseText = (inner.responseText as string) ?? (e.responseText as string);
  const response = (inner.response as string) ?? (e.response as string);
  const serverResponseCode = (inner.serverResponseCode as string) ?? (e.serverResponseCode as string);
  if (responseText) return responseText;
  if (serverResponseCode) return `${serverResponseCode}: ${(response ?? inner.message ?? e.message) || "Unknown"}`;
  if (response && typeof response === "string") return response.replace(/^\d+ (NO|BAD) /i, "").trim() || String(response);
  return (e.message as string) ?? (inner.message as string) ?? String(err);
}

export type MailMessagePayload = {
  bus_id: string;
  user_id: number;
  user_name: string;
  content: string;
  timestamp?: string;
  /** IMAP UID for deletion on bus cleanup */
  mail_uid?: number;
  /** Sender email for identity resolution */
  sender_email?: string;
};

export type OnMailMessageCallback = (payload: MailMessagePayload, opts?: { deliverToModel?: boolean }) => void;

let client: ImapFlow | null = null;
let currentLock: { release: () => void } | null = null;
let lastOpenedMailbox: string | null = null;
let storedParams: MailConnectParams | null = null;
let onMailMessage: OnMailMessageCallback | null = null;
let currentAccount: string | null = null;
let reconnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let idleAbortController: AbortController | null = null;
let idleScheduled = false;
let idleInProgress = false;

const RECONNECT_DELAY_MS = 5_000;

/** Enable IMAP debug logging. Set YAAIA_IMAP_DEBUG=1 in env or pass true to mailConnect. */
const IMAP_DEBUG = process.env.YAAIA_IMAP_DEBUG === "1" || process.env.YAAIA_IMAP_DEBUG === "true";

const imapLogger = IMAP_DEBUG
  ? {
      debug: (obj: unknown) => console.log("[YAAIA IMAP debug]", typeof obj === "object" ? JSON.stringify(obj) : obj),
      info: (obj: unknown) => console.info("[YAAIA IMAP info]", typeof obj === "object" ? JSON.stringify(obj) : obj),
      warn: (obj: unknown) => console.warn("[YAAIA IMAP warn]", typeof obj === "object" ? JSON.stringify(obj) : obj),
      error: (obj: unknown) => console.error("[YAAIA IMAP error]", typeof obj === "object" ? JSON.stringify(obj) : obj),
    }
  : false;

export interface MailConnectParams {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
}

export function setOnMailMessage(cb: OnMailMessageCallback | null): void {
  onMailMessage = cb;
}

export function isMailConnected(): boolean {
  return client !== null;
}

function getLastTimestampPath(account: string): string {
  return join(YAAIA_DIR, `mail-last-${sanitizeAccountForBusId(account)}.json`);
}

function loadLastTimestamp(account: string): number {
  try {
    const path = getLastTimestampPath(account);
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const ts = typeof raw?.lastMessageDate === "number" ? raw.lastMessageDate : 0;
      return ts > 0 ? ts : 0;
    }
  } catch (err) {
    console.warn("[YAAIA Mail] Failed to load last timestamp:", err);
  }
  return 0;
}

function saveLastTimestamp(account: string, date: number): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    const path = getLastTimestampPath(account);
    writeFileSync(path, JSON.stringify({ lastMessageDate: date }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[YAAIA Mail] Failed to save last timestamp:", err);
  }
}

function formatMessageContent(envelope: { from?: { address?: string; name?: string }[]; subject?: string; date?: Date }, body: string): string {
  const from = envelope?.from?.[0];
  const fromStr = from ? (from.name ? `${from.name} <${from.address ?? ""}>` : from.address ?? "") : "unknown";
  const subject = envelope?.subject ?? "(no subject)";
  const date = envelope?.date instanceof Date ? envelope.date.toISOString() : "";
  const header = `From: ${fromStr}\nSubject: ${subject}\nDate: ${date}\n\n`;
  return header + (body || "(no body)");
}

async function scheduleReconnect(): Promise<void> {
  if (reconnectTimeoutHandle) return;
  if (!storedParams) return;
  console.log("[YAAIA Mail] Scheduling reconnect in", RECONNECT_DELAY_MS, "ms");
  reconnectTimeoutHandle = setTimeout(async () => {
    reconnectTimeoutHandle = null;
    try {
      console.log("[YAAIA Mail] Attempting reconnect...");
      await mailConnect(storedParams!);
      if (currentAccount) await mailInitInboxAndWatch(currentAccount);
    } catch (err) {
      console.warn("[YAAIA Mail] Reconnect failed:", err instanceof Error ? err.message : err);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

export async function mailConnect(params: MailConnectParams): Promise<void> {
  await mailDisconnect();
  const { host, port, user, pass, secure = true } = params;
  storedParams = { host, port, user, pass, secure };
  client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    socketTimeout: 10 * 60 * 1000,
    logger: imapLogger,
    logRaw: IMAP_DEBUG,
    disableAutoIdle: true, // We manage IDLE manually; prevents conflict when running mail.list etc. while idling
  });
  client.on("error", (err: Error) => {
    console.error("[YAAIA Mail] IMAP error:", err.message);
    if (idleAbortController) {
      idleAbortController.abort();
      idleAbortController = null;
    }
    if (client) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      client = null;
      currentLock = null;
      lastOpenedMailbox = null;
    }
    scheduleReconnect();
  });
  await client.connect();
  lastOpenedMailbox = null;
}

export async function mailDisconnect(): Promise<void> {
  if (reconnectTimeoutHandle) {
    clearTimeout(reconnectTimeoutHandle);
    reconnectTimeoutHandle = null;
  }
  if (idleAbortController) {
    idleAbortController.abort();
    idleAbortController = null;
  }
  storedParams = null;
  currentAccount = null;
  idleScheduled = false;
  idleInProgress = false;
  if (currentLock) {
    try {
      currentLock.release();
    } catch {
      /* ignore */
    }
    currentLock = null;
  }
  if (client) {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    client = null;
  }
  lastOpenedMailbox = null;
}

/** Delete messages from INBOX by UID. Call when cleaning up an email bus. Requires mail to be connected. */
export async function mailDeleteMessagesByUids(uids: number[]): Promise<void> {
  const c = client;
  if (!c) throw new Error("Not connected. Call mail.connect first.");
  if (uids.length === 0) return;
  await pauseIdleForCommand();
  await c.mailboxOpen(INBOX, { readOnly: false });
  const lock = await c.getMailboxLock(INBOX);
  try {
    await c.messageDelete(uids.join(","), { uid: true });
  } finally {
    lock.release();
  }
}

/** Open INBOX, fetch all or delta, populate bus, set up IDLE for new messages. Call after mailConnect. */
export async function mailInitInboxAndWatch(account: string): Promise<{ busId: string; messageCount: number }> {
  const c = client;
  if (!c) throw new Error("Not connected. Call mail.connect first.");
  currentAccount = account;
  const busId = `email-${sanitizeAccountForBusId(account)}`;
  await c.mailboxOpen(INBOX, { readOnly: false });
  lastOpenedMailbox = INBOX;

  const lastTs = loadLastTimestamp(account);
  let messageCount = 0;
  let maxDate = lastTs;

  const lock = await c.getMailboxLock(INBOX);
  try {
    if (lastTs > 0) {
      const uids = await c.search({ since: new Date(lastTs) }, { uid: true });
      const uidList = Array.isArray(uids) ? uids : [];
      if (uidList.length > 0) {
        const messages = await c.fetch(uidList.join(","), { envelope: true, source: true, internalDate: true }, { uid: true });
        const list: { uid?: number; internalDate?: Date | string; envelope: { from?: { address?: string; name?: string }[]; subject?: string; date?: Date }; source?: Buffer | string }[] = [];
        for await (const m of messages) {
          list.push({ uid: m.uid, internalDate: m.internalDate, envelope: m.envelope as never, source: m.source });
        }
        await c.messageFlagsAdd(uidList.join(","), ["\\Seen"], { uid: true });
        for (const m of list) {
          let body = "";
          const src = m.source;
          if (src) {
            try {
              const parsed = await simpleParser(typeof src === "string" ? src : Buffer.from(src));
              body = String(parsed.text ?? parsed.html ?? "");
            } catch {
              body = String(src);
            }
          }
          const content = formatMessageContent(m.envelope, body);
          const id = m.internalDate;
          const date = id instanceof Date ? id.getTime() : (typeof id === "string" ? new Date(id).getTime() : (m.envelope?.date instanceof Date ? m.envelope.date.getTime() : Date.now()));
          const timestamp = id instanceof Date ? id.toISOString() : (typeof id === "string" ? new Date(id).toISOString() : (m.envelope?.date instanceof Date ? m.envelope.date.toISOString() : undefined));
          const from = m.envelope?.from?.[0];
          const userName = from ? (from.name ?? from.address ?? account) : account;
          const senderEmail = from?.address;
          const payload: MailMessagePayload = { bus_id: busId, user_id: 0, user_name: userName, content, timestamp, mail_uid: m.uid, sender_email: senderEmail };
          /* deliverToModel: false — init fetch during connect. Messages go to bus history; agent can get_bus_history to see them. Only IDLE deliverToModel: true for live arrivals. */
          onMailMessage?.(payload, { deliverToModel: false });
          messageCount++;
          if (date > maxDate) maxDate = date;
        }
        saveLastTimestamp(account, maxDate);
      }
    } else {
      const status = await c.status(INBOX, { messages: true });
      const total = (status as { messages?: number }).messages ?? 0;
      if (total > 0) {
        const messages = await c.fetch("1:*", { envelope: true, source: true, internalDate: true });
        const list: { uid?: number; internalDate?: Date | string; envelope: { from?: { address?: string; name?: string }[]; subject?: string; date?: Date }; source?: Buffer | string }[] = [];
        for await (const m of messages) {
          list.push({ uid: m.uid, internalDate: m.internalDate, envelope: m.envelope as never, source: m.source });
        }
        const uidList = list.map((m) => m.uid).filter((u): u is number => u != null);
        if (uidList.length > 0) {
          await c.messageFlagsAdd(uidList.join(","), ["\\Seen"], { uid: true });
        }
        for (const m of list) {
          let body = "";
          const src = m.source;
          if (src) {
            try {
              const parsed = await simpleParser(typeof src === "string" ? src : Buffer.from(src));
              body = String(parsed.text ?? parsed.html ?? "");
            } catch {
              body = String(src);
            }
          }
          const content = formatMessageContent(m.envelope, body);
          const id = m.internalDate;
          const date = id instanceof Date ? id.getTime() : (typeof id === "string" ? new Date(id).getTime() : (m.envelope?.date instanceof Date ? m.envelope.date.getTime() : Date.now()));
          const timestamp = id instanceof Date ? id.toISOString() : (typeof id === "string" ? new Date(id).toISOString() : (m.envelope?.date instanceof Date ? m.envelope.date.toISOString() : undefined));
          const from = m.envelope?.from?.[0];
          const userName = from ? (from.name ?? from.address ?? account) : account;
          const senderEmail = from?.address;
          const payload: MailMessagePayload = { bus_id: busId, user_id: 0, user_name: userName, content, timestamp, mail_uid: m.uid, sender_email: senderEmail };
          onMailMessage?.(payload, { deliverToModel: false });
          messageCount++;
          if (date > maxDate) maxDate = date;
        }
        saveLastTimestamp(account, maxDate);
      }
    }
  } finally {
    lock.release();
  }

  const scheduleStartIdle = (): void => {
    if (idleScheduled || !client || !currentAccount) return;
    idleScheduled = true;
    setTimeout(() => {
      idleScheduled = false;
      startIdle();
    }, 1000);
  };

  const startIdle = async (): Promise<void> => {
    if (!client || !currentAccount) return;
    if (idleInProgress) return;
    idleInProgress = true;
    try {
      await c.mailboxOpen(INBOX, { readOnly: false });
      lastOpenedMailbox = INBOX;
    } catch (err) {
      idleInProgress = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[YAAIA Mail] Failed to open INBOX for IDLE:", msg);
      const isConnectionError =
        /connection not available|connection closed|connection lost|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(msg);
      if (isConnectionError) {
        if (client) {
          try {
            client.close();
          } catch {
            /* ignore */
          }
          client = null;
          currentLock = null;
          lastOpenedMailbox = null;
        }
        scheduleReconnect();
      } else if (client && currentAccount) {
        scheduleStartIdle();
      }
      return;
    }
    idleAbortController = new AbortController();
    const handleExists = async (data: { path: string; count: number; prevCount: number }): Promise<void> => {
      if (!onMailMessage) return;
      if (data.count <= data.prevCount) return;
      try {
        const unseenUids = await c.search({ seen: false }, { uid: true });
        const uidList = Array.isArray(unseenUids) ? unseenUids : [];
        if (uidList.length === 0) return;
        const lock = await c.getMailboxLock(INBOX);
        try {
          const messages = await c.fetch(uidList.join(","), { envelope: true, source: true, internalDate: true }, { uid: true });
          const list: { uid?: number; internalDate?: Date | string; envelope: { from?: { address?: string; name?: string }[]; subject?: string; date?: Date }; source?: Buffer | string }[] = [];
          for await (const m of messages) {
            list.push({ uid: m.uid, internalDate: m.internalDate, envelope: m.envelope as never, source: m.source });
          }
          // Mark as read before delivering so inbox shows read by the time user sees it
          if (uidList.length > 0) {
            await c.messageFlagsAdd(uidList.join(","), ["\\Seen"], { uid: true });
          }
          for (const m of list) {
            let body = "";
            const src = m.source;
            if (src) {
              try {
                const parsed = await simpleParser(typeof src === "string" ? src : Buffer.from(src));
                body = String(parsed.text ?? parsed.html ?? "");
              } catch {
                body = String(src);
              }
            }
            const content = formatMessageContent(m.envelope, body);
            const id = m.internalDate;
            const date = id instanceof Date ? id.getTime() : (typeof id === "string" ? new Date(id).getTime() : (m.envelope?.date instanceof Date ? m.envelope.date.getTime() : Date.now()));
            const timestamp = id instanceof Date ? id.toISOString() : (typeof id === "string" ? new Date(id).toISOString() : (m.envelope?.date instanceof Date ? m.envelope.date.toISOString() : undefined));
            const from = m.envelope?.from?.[0];
            const userName = from ? (from.name ?? from.address ?? account) : account;
            const senderEmail = from?.address;
            const payload: MailMessagePayload = { bus_id: busId, user_id: 0, user_name: userName, content, timestamp, mail_uid: m.uid, sender_email: senderEmail };
            onMailMessage?.(payload, { deliverToModel: true });
            if (date > maxDate) maxDate = date;
          }
          saveLastTimestamp(account, maxDate);
        } finally {
          lock.release();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[YAAIA Mail] exists handler error:", msg);
        const isConnectionError =
          /connection not available|connection closed|connection lost|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(msg);
        if (isConnectionError && client) {
          try {
            client.close();
          } catch {
            /* ignore */
          }
          client = null;
          currentLock = null;
          lastOpenedMailbox = null;
          scheduleReconnect();
          return;
        }
      }
    };
    c.once("exists", handleExists);
    try {
      await Promise.race([
        c.idle(),
        new Promise<never>((_, reject) => {
          idleAbortController!.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ]);
    } catch {
      /* aborted or closed */
    }
    idleAbortController = null;
    idleInProgress = false;
    scheduleStartIdle();
  };
  // Defer IDLE so mail.list etc. can run immediately after connect without needing to break IDLE
  scheduleStartIdle();

  return { busId, messageCount };
}

function getClient(): ImapFlow {
  if (!client) throw new Error("Not connected. Call mail.connect first.");
  return client;
}

/** Break IDLE so other commands can run. Must be called before any mail command when IDLE may be active. */
async function pauseIdleForCommand(): Promise<void> {
  const c = client;
  if (!c) return;
  if (typeof (c as unknown as { preCheck?: () => Promise<void> }).preCheck === "function") {
    await (c as unknown as { preCheck: () => Promise<void> }).preCheck();
  }
}

export async function ensureMailbox(path?: string): Promise<string> {
  const mailbox = path ?? lastOpenedMailbox;
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox path or call mail.mailbox_open first.");
  const c = getClient();
  await pauseIdleForCommand();
  if (currentLock) {
    currentLock.release();
    currentLock = null;
  }
  const lock = await c.getMailboxLock(mailbox);
  currentLock = lock;
  lastOpenedMailbox = mailbox;
  return mailbox;
}

export function releaseMailboxLock(): void {
  if (currentLock) {
    currentLock.release();
    currentLock = null;
  }
}

export async function mailList(options?: {
  statusQuery?: { messages?: boolean; unseen?: boolean; uidNext?: boolean; uidValidity?: boolean; recent?: boolean; highestModseq?: boolean };
}): Promise<unknown> {
  const c = getClient();
  await pauseIdleForCommand();
  const list = await c.list(options);
  releaseMailboxLock();
  return list.map((m) => ({
    path: m.path,
    name: m.name,
    specialUse: m.specialUse,
    ...(m.status && { status: m.status }),
  }));
}

export async function mailListTree(options?: object): Promise<unknown> {
  const c = getClient();
  await pauseIdleForCommand();
  const tree = await c.listTree(options);
  releaseMailboxLock();
  return tree;
}

export async function mailMailboxOpen(path: string, readOnly?: boolean): Promise<void> {
  const c = getClient();
  await pauseIdleForCommand();
  if (currentLock) {
    currentLock.release();
    currentLock = null;
  }
  await c.mailboxOpen(path, { readOnly });
  lastOpenedMailbox = path;
}

export async function mailMailboxClose(): Promise<void> {
  const c = getClient();
  await pauseIdleForCommand();
  await c.mailboxClose();
  releaseMailboxLock();
  lastOpenedMailbox = null;
}

export async function mailMailboxCreate(path: string): Promise<unknown> {
  const c = getClient();
  await pauseIdleForCommand();
  const result = await c.mailboxCreate(path);
  releaseMailboxLock();
  return result;
}

export async function mailMailboxRename(oldPath: string, newPath: string): Promise<void> {
  const c = getClient();
  await pauseIdleForCommand();
  await c.mailboxRename(oldPath, newPath);
  releaseMailboxLock();
}

export async function mailMailboxDelete(path: string): Promise<void> {
  const c = getClient();
  await pauseIdleForCommand();
  await c.mailboxDelete(path);
  releaseMailboxLock();
}

export async function mailMailboxSubscribe(path: string): Promise<void> {
  const c = getClient();
  await pauseIdleForCommand();
  await c.mailboxSubscribe(path);
  releaseMailboxLock();
}

export async function mailMailboxUnsubscribe(path: string): Promise<void> {
  const c = getClient();
  await pauseIdleForCommand();
  await c.mailboxUnsubscribe(path);
  releaseMailboxLock();
}

export async function mailStatus(path: string, query: {
  messages?: boolean;
  unseen?: boolean;
  uidNext?: boolean;
  uidValidity?: boolean;
  recent?: boolean;
  highestModseq?: boolean;
}): Promise<unknown> {
  const c = getClient();
  await pauseIdleForCommand();
  const status = await c.status(path, query);
  releaseMailboxLock();
  return status;
}

export async function mailGetQuota(path: string): Promise<unknown> {
  const c = getClient();
  await pauseIdleForCommand();
  const quota = await c.getQuota(path);
  releaseMailboxLock();
  return quota;
}

export async function mailFetchAll(
  range: string,
  query: Record<string, unknown>,
  options: { uid?: boolean; mailbox?: string } = {}
): Promise<unknown[]> {
  const mailbox = options.mailbox ?? lastOpenedMailbox;
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail.mailbox_open first.");
  const c = getClient();
  await pauseIdleForCommand();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const messages = await c.fetchAll(range, query as object, { uid: options.uid });
    if (query.source === true) {
      const toMark = messages.filter((m) => {
        const f = m.flags;
        const hasSeen = f instanceof Set ? f.has("\\Seen") : (Array.isArray(f) ? f : ([] as string[])).includes("\\Seen");
        return !hasSeen;
      });
      if (toMark.length > 0) {
        const range = toMark.map((m) => (options.uid ? m.uid : m.seq)).join(",");
        await c.messageFlagsAdd(range, ["\\Seen"], { uid: options.uid });
      }
    }
    return messages.map((m) => ({
      uid: m.uid,
      seq: m.seq,
      envelope: m.envelope,
      flags: m.flags,
      internalDate: m.internalDate,
      size: m.size,
      ...(m.source && { source: String(m.source) }),
      ...(m.labels && { labels: m.labels }),
      ...(m.threadId && { threadId: m.threadId }),
    }));
  } finally {
    lock.release();
  }
}

export async function mailFetchOne(
  seq: string,
  query: Record<string, unknown>,
  options: { uid?: boolean; mailbox?: string } = {}
): Promise<unknown> {
  const mailbox = options.mailbox ?? lastOpenedMailbox;
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail.mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const msg = await c.fetchOne(seq, query as object, { uid: options.uid });
    if (!msg) return null;
    const f = msg.flags;
    const hasSeen = f instanceof Set ? f.has("\\Seen") : (Array.isArray(f) ? f : ([] as string[])).includes("\\Seen");
    if (query.source === true && !hasSeen) {
      const range = options.uid ? String(msg.uid) : String(msg.seq);
      await c.messageFlagsAdd(range, ["\\Seen"], { uid: options.uid });
    }
    return {
      uid: msg.uid,
      seq: msg.seq,
      envelope: msg.envelope,
      flags: msg.flags,
      internalDate: msg.internalDate,
      size: msg.size,
      ...(msg.source && { source: String(msg.source) }),
      ...(msg.labels && { labels: msg.labels }),
      ...(msg.threadId && { threadId: msg.threadId }),
    };
  } finally {
    lock.release();
  }
}

export async function mailDownload(
  range: string,
  part: string,
  options: { uid?: boolean; mailbox?: string } = {}
): Promise<string> {
  const mailbox = options.mailbox ?? lastOpenedMailbox;
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail.mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const partOpt = part.trim() || undefined;
    const { meta, content } = await c.download(range, partOpt, { uid: options.uid });
    const filename = meta.filename || `mail-part-${range}-${part}-${Date.now()}`;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    mkdirSync(SHARED_DIR, { recursive: true });
    const filepath = join(SHARED_DIR, safeName);
    const writable = createWriteStream(filepath);
    const stream = content instanceof Readable ? content : Readable.from(content);
    await pipeline(stream, writable);
    return `Saved to ${filepath}`;
  } finally {
    lock.release();
  }
}

export async function mailSearch(
  query: Record<string, unknown>,
  options: { uid?: boolean; mailbox?: string } = {}
): Promise<number[]> {
  const mailbox = options.mailbox ?? lastOpenedMailbox;
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail.mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const uids = await c.search(query as object, { uid: options.uid });
    return (Array.isArray(uids) ? uids : []) as number[];
  } finally {
    lock.release();
  }
}

export async function mailMessageDelete(range: string, uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageDelete(range, { uid });
  releaseMailboxLock();
}

export async function mailMessageCopy(range: string, destination: string, uid?: boolean): Promise<unknown> {
  await ensureMailbox();
  const c = getClient();
  const result = await c.messageCopy(range, destination, { uid });
  releaseMailboxLock();
  return result;
}

export async function mailMessageMove(range: string, destination: string, uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageMove(range, destination, { uid });
  releaseMailboxLock();
}

export async function mailMessageFlagsAdd(range: string, flags: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageFlagsAdd(range, flags, { uid });
  releaseMailboxLock();
}

export async function mailMessageFlagsRemove(range: string, flags: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageFlagsRemove(range, flags, { uid });
  releaseMailboxLock();
}

export async function mailMessageFlagsSet(range: string, flags: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageFlagsSet(range, flags, { uid });
  releaseMailboxLock();
}

export async function mailSetFlagColor(range: string, color: string, uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.setFlagColor(range, color as "red" | "orange" | "yellow" | "green" | "blue" | "purple", { uid });
  releaseMailboxLock();
}

export async function mailMessageLabelsAdd(range: string, labels: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await (c as { messageLabelsAdd?: (r: string, l: string[], o?: { uid?: boolean }) => Promise<void> }).messageLabelsAdd?.(range, labels, { uid });
  releaseMailboxLock();
}

export async function mailMessageLabelsRemove(range: string, labels: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await (c as { messageLabelsRemove?: (r: string, l: string[], o?: { uid?: boolean }) => Promise<void> }).messageLabelsRemove?.(range, labels, { uid });
  releaseMailboxLock();
}

export async function mailMessageLabelsSet(range: string, labels: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await (c as { messageLabelsSet?: (r: string, l: string[], o?: { uid?: boolean }) => Promise<void> }).messageLabelsSet?.(range, labels, { uid });
  releaseMailboxLock();
}

export async function mailAppend(path: string, content: string, flags?: string[], idate?: string): Promise<unknown> {
  const c = getClient();
  const fl = flags ?? [];
  const date = idate ? new Date(idate) : undefined;
  return await c.append(path, content, fl, date);
}
