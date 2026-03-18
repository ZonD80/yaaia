/**
 * Structured identities: name, identifier (memory partition key), trust_level, bus_ids, note.
 * Note stored at ~/yaaia/identities/{identifier}.md (internal).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resetIdentityAttempts } from "./identity-attempts-store.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const IDENTITIES_PATH = join(YAAIA_DIR, "identities.json");
const IDENTITIES_NOTES_DIR = join(YAAIA_DIR, "identities");

export type IdentityTrustLevel = "root" | "normal";

export type Identity = {
  id: string;
  name: string;
  identifier: string;
  trust_level: IdentityTrustLevel;
  bus_ids: string[];
};

type IdentitiesFile = {
  v?: number;
  items: Identity[];
};

const DEFAULT_IDENTIFIER = "user";
const MAX_IDENTIFIER_LEN = 200;

function loadIdentities(): Identity[] {
  try {
    if (existsSync(IDENTITIES_PATH)) {
      const raw = JSON.parse(readFileSync(IDENTITIES_PATH, "utf-8"));
      if (raw?.items && Array.isArray(raw.items)) {
        return raw.items as Identity[];
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Identities load failed:", err);
  }
  return [];
}

function saveIdentities(items: Identity[]): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(IDENTITIES_PATH, JSON.stringify({ v: 1, items }, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save identities:", err);
  }
}

function sanitizeIdentifier(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9@._-]/g, "_").slice(0, MAX_IDENTIFIER_LEN) || "unnamed";
}

function ensureIdentityNoteDir(): void {
  mkdirSync(IDENTITIES_NOTES_DIR, { recursive: true });
}

export function identityList(): Identity[] {
  return loadIdentities();
}

export type IdentityWithNote = Identity & { note: string };

export function identityGet(idOrIdentifier: string): IdentityWithNote | null {
  const items = loadIdentities();
  const byId = items.find((e) => e.id === idOrIdentifier);
  const entry = byId ?? items.find((e) => e.identifier === idOrIdentifier) ?? null;
  if (!entry) return null;
  const note = identityGetNote(entry.identifier);
  return { ...entry, note };
}

export function identityCreate(args: {
  name: string;
  identifier: string;
  trust_level?: IdentityTrustLevel;
  bus_ids?: string[];
}): string {
  const identifier = sanitizeIdentifier(args.identifier);
  if (!identifier) throw new Error("identifier is required");
  const items = loadIdentities();
  if (items.some((e) => e.identifier === identifier)) {
    throw new Error(`Identity with identifier "${identifier}" already exists`);
  }
  const id = randomUUID();
  const entry: Identity = {
    id,
    name: (args.name || identifier).trim(),
    identifier,
    trust_level: args.trust_level ?? "normal",
    bus_ids: Array.isArray(args.bus_ids) ? args.bus_ids : [],
  };
  saveIdentities([...items, entry]);
  ensureIdentityNoteDir();
  const notePath = join(IDENTITIES_NOTES_DIR, `${identifier}.md`);
  if (!existsSync(notePath)) {
    writeFileSync(notePath, `# ${entry.name}\n\nContacts and relevant information.\n`, "utf-8");
  }
  for (const bid of entry.bus_ids) resetIdentityAttempts(bid);
  return id;
}

export function identityUpdate(
  idOrIdentifier: string,
  updates: { name?: string; identifier?: string; trust_level?: IdentityTrustLevel; bus_ids?: string[] }
): void {
  const items = loadIdentities();
  const idx = items.findIndex((e) => e.id === idOrIdentifier || e.identifier === idOrIdentifier);
  if (idx < 0) throw new Error(`Identity not found: ${idOrIdentifier}`);
  const entry = items[idx]!;
  if (updates.identifier != null) {
    const newId = sanitizeIdentifier(updates.identifier);
    if (newId && newId !== entry.identifier) {
      if (items.some((e) => e.identifier === newId && e.id !== entry.id)) {
        throw new Error(`Identifier "${newId}" already in use`);
      }
      const oldPath = join(IDENTITIES_NOTES_DIR, `${entry.identifier}.md`);
      const newPath = join(IDENTITIES_NOTES_DIR, `${newId}.md`);
      if (existsSync(oldPath) && !existsSync(newPath)) {
        const content = readFileSync(oldPath, "utf-8");
        writeFileSync(newPath, content, "utf-8");
        try {
          unlinkSync(oldPath);
        } catch {
          /* ignore */
        }
      }
      entry.identifier = newId;
    }
  }
  if (updates.name != null) entry.name = updates.name.trim();
  if (updates.trust_level != null) entry.trust_level = updates.trust_level;
  if (updates.bus_ids != null) {
    entry.bus_ids = Array.isArray(updates.bus_ids) ? updates.bus_ids : entry.bus_ids;
    for (const bid of entry.bus_ids) resetIdentityAttempts(bid);
  }
  items[idx] = entry;
  saveIdentities(items);
}

export function identityDelete(idOrIdentifier: string): void {
  const items = loadIdentities();
  const entry = items.find((e) => e.id === idOrIdentifier || e.identifier === idOrIdentifier);
  if (!entry) throw new Error(`Identity not found: ${idOrIdentifier}`);
  saveIdentities(items.filter((e) => e.id !== entry.id));
  const notePath = join(IDENTITIES_NOTES_DIR, `${entry.identifier}.md`);
  if (existsSync(notePath)) {
    try {
      unlinkSync(notePath);
    } catch {
      /* ignore */
    }
  }
}

export function identityGetNote(identifier: string): string {
  ensureIdentityNoteDir();
  const path = join(IDENTITIES_NOTES_DIR, `${sanitizeIdentifier(identifier)}.md`);
  if (existsSync(path)) {
    return readFileSync(path, "utf-8");
  }
  return "";
}

export function identitySetNote(identifier: string, content: string): void {
  ensureIdentityNoteDir();
  const path = join(IDENTITIES_NOTES_DIR, `${sanitizeIdentifier(identifier)}.md`);
  writeFileSync(path, content, "utf-8");
}

/**
 * Resolve identity for (bus_id, sender_email?).
 * - root → "user"
 * - telegram-X → identity with bus_ids containing telegram-X
 * - email-X + sender → identity with identifier=sender and bus_ids containing email-X
 */
export function resolveIdentity(busId: string, senderEmail?: string): Identity | null {
  const items = loadIdentities();

  if (busId === "root") {
    return items.find((e) => e.identifier === DEFAULT_IDENTIFIER) ?? null;
  }

  if (busId.startsWith("telegram-")) {
    return items.find((e) => e.bus_ids.includes(busId)) ?? null;
  }

  if (busId.startsWith("email-") && senderEmail) {
    const normalized = senderEmail.trim().toLowerCase();
    return items.find((e) => e.identifier === normalized && e.bus_ids.includes(busId)) ?? null;
  }

  return items.find((e) => e.bus_ids.includes(busId)) ?? null;
}

/** Trust level for bus: from identity or default "normal". */
export function getTrustLevelForBus(busId: string, senderEmail?: string): IdentityTrustLevel {
  const identity = resolveIdentity(busId, senderEmail);
  return identity?.trust_level ?? "normal";
}

/** Whether bus is trusted (root). */
export function isBusTrusted(busId: string, senderEmail?: string): boolean {
  return getTrustLevelForBus(busId, senderEmail) === "root";
}

/** Update trust_level of identity that contains this bus_id. For root/telegram. Email needs sender. */
export function identityUpdateTrustByBusId(busId: string, trust_level: IdentityTrustLevel): boolean {
  const identity = resolveIdentity(busId);
  if (!identity) return false;
  identityUpdate(identity.id, { trust_level });
  return true;
}

export { DEFAULT_IDENTIFIER };
