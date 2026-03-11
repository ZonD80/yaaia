/**
 * IMAP client wrapper using imapflow. Single connection per session.
 * Keep-alive poll every 60s when connected. Disconnect on session end.
 */

import { ImapFlow } from "imapflow";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

let client: ImapFlow | null = null;
let currentLock: { release: () => void } | null = null;
let lastOpenedMailbox: string | null = null;
let keepAliveIntervalHandle: ReturnType<typeof setInterval> | null = null;

const KEEP_ALIVE_INTERVAL_MS = 60_000;

const DOWNLOADS_DIR = join(homedir(), "Downloads");

export interface MailConnectParams {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
}

export function isMailConnected(): boolean {
  return client !== null;
}

export async function mailConnect(params: MailConnectParams): Promise<void> {
  await mailDisconnect();
  const { host, port, user, pass, secure = true } = params;
  client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    socketTimeout: 10 * 60 * 1000, // 10 min (default 5 min can trigger on slow ops)
  });
  // Prevent uncaught exceptions from socket timeout / connection errors
  client.on("error", (err: Error) => {
    console.error("[YAAIA Mail] IMAP error:", err.message);
    if (keepAliveIntervalHandle) {
      clearInterval(keepAliveIntervalHandle);
      keepAliveIntervalHandle = null;
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
  });
  await client.connect();
  lastOpenedMailbox = null;

  if (keepAliveIntervalHandle) clearInterval(keepAliveIntervalHandle);
  keepAliveIntervalHandle = setInterval(async () => {
    if (!client) return;
    try {
      await client.noop();
    } catch (err) {
      console.warn("[YAAIA Mail] Keep-alive noop failed:", err instanceof Error ? err.message : err);
    }
  }, KEEP_ALIVE_INTERVAL_MS);
}

export async function mailDisconnect(): Promise<void> {
  if (keepAliveIntervalHandle) {
    clearInterval(keepAliveIntervalHandle);
    keepAliveIntervalHandle = null;
  }
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

function getClient(): ImapFlow {
  if (!client) throw new Error("Not connected. Call mail__connect first.");
  return client;
}

export async function ensureMailbox(path?: string): Promise<string> {
  const mailbox = path ?? lastOpenedMailbox;
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox path or call mail__mailbox_open first.");
  const c = getClient();
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
  const tree = await c.listTree(options);
  releaseMailboxLock();
  return tree;
}

export async function mailMailboxOpen(path: string, readOnly?: boolean): Promise<void> {
  const c = getClient();
  if (currentLock) {
    currentLock.release();
    currentLock = null;
  }
  await c.mailboxOpen(path, { readOnly });
  lastOpenedMailbox = path;
}

export async function mailMailboxClose(): Promise<void> {
  const c = getClient();
  await c.mailboxClose();
  releaseMailboxLock();
  lastOpenedMailbox = null;
}

export async function mailMailboxCreate(path: string): Promise<unknown> {
  const c = getClient();
  const result = await c.mailboxCreate(path);
  releaseMailboxLock();
  return result;
}

export async function mailMailboxRename(oldPath: string, newPath: string): Promise<void> {
  const c = getClient();
  await c.mailboxRename(oldPath, newPath);
  releaseMailboxLock();
}

export async function mailMailboxDelete(path: string): Promise<void> {
  const c = getClient();
  await c.mailboxDelete(path);
  releaseMailboxLock();
}

export async function mailMailboxSubscribe(path: string): Promise<void> {
  const c = getClient();
  await c.mailboxSubscribe(path);
  releaseMailboxLock();
}

export async function mailMailboxUnsubscribe(path: string): Promise<void> {
  const c = getClient();
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
  const status = await c.status(path, query);
  releaseMailboxLock();
  return status;
}

export async function mailGetQuota(path: string): Promise<unknown> {
  const c = getClient();
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
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail__mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const messages = await c.fetchAll(range, query as object, { uid: options.uid });
    if (query.source === true) {
      const toMark = messages.filter((m) => !m.flags?.includes("\\Seen"));
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
      ...(m.source && { source: String(m.source).slice(0, 50000) }),
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
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail__mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const msg = await c.fetchOne(seq, query as object, { uid: options.uid });
    if (!msg) return null;
    if (query.source === true && !msg.flags?.includes("\\Seen")) {
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
      ...(msg.source && { source: String(msg.source).slice(0, 50000) }),
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
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail__mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const partOpt = part.trim() || undefined;
    const { meta, content } = await c.download(range, partOpt, { uid: options.uid });
    const filename = meta.filename || `mail-part-${range}-${part}-${Date.now()}`;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filepath = join(DOWNLOADS_DIR, safeName);
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
  if (!mailbox) throw new Error("No mailbox selected. Provide mailbox or call mail__mailbox_open first.");
  const c = getClient();
  const lock = await c.getMailboxLock(mailbox);
  try {
    const uids = await c.search(query as object, { uid: options.uid });
    return uids;
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
  await c.messageLabelsAdd(range, labels, { uid });
  releaseMailboxLock();
}

export async function mailMessageLabelsRemove(range: string, labels: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageLabelsRemove(range, labels, { uid });
  releaseMailboxLock();
}

export async function mailMessageLabelsSet(range: string, labels: string[], uid?: boolean): Promise<void> {
  await ensureMailbox();
  const c = getClient();
  await c.messageLabelsSet(range, labels, { uid });
  releaseMailboxLock();
}

export async function mailAppend(path: string, content: string, flags?: string[], idate?: string): Promise<unknown> {
  const c = getClient();
  const fl = flags ?? [];
  const date = idate ? new Date(idate) : undefined;
  return await c.append(path, content, fl, date);
}
