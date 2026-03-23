/**
 * Contacts: name, identifier (memory key, email match), bus_ids, trust_level, notes.
 * Stored in history.db contacts table.
 */

import BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resetIdentityAttempts } from "./identity-attempts-store.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const HISTORY_DB_PATH = join(YAAIA_DIR, "storage", "history.db");

export type ContactTrustLevel = "root" | "normal";

export type Contact = {
  id: string;
  name: string;
  identifier: string;
  trust_level: ContactTrustLevel;
  bus_ids: string[];
  notes: string;
};

export type ContactWithNote = Contact;

const DEFAULT_IDENTIFIER = "user";
const MAX_IDENTIFIER_LEN = 200;

let db: InstanceType<typeof BetterSqlite3> | null = null;

function getDb(): InstanceType<typeof BetterSqlite3> {
  if (!db) {
    const dir = join(YAAIA_DIR, "storage");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new BetterSqlite3(HISTORY_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        identifier TEXT NOT NULL,
        bus_ids TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'normal' CHECK (trust_level IN ('normal', 'root')),
        notes TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_identifier ON contacts(identifier);
    `);
  }
  return db;
}

function sanitizeIdentifier(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9@._-]/g, "_").slice(0, MAX_IDENTIFIER_LEN) || "unnamed";
}

function parseBusIds(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function contactList(): Contact[] {
  const rows = getDb().prepare("SELECT id, name, identifier, bus_ids, trust_level, notes FROM contacts").all();
  return (rows as { id: string; name: string; identifier: string; bus_ids: string; trust_level: string; notes: string }[]).map((r) => ({
    id: r.id,
    name: r.name,
    identifier: r.identifier,
    trust_level: r.trust_level as ContactTrustLevel,
    bus_ids: parseBusIds(r.bus_ids),
    notes: r.notes || "",
  }));
}

export function contactSearch(query: string): Contact[] {
  const q = `%${String(query || "").trim()}%`;
  const rows = getDb()
    .prepare(
      "SELECT id, name, identifier, bus_ids, trust_level, notes FROM contacts WHERE name LIKE ? OR notes LIKE ?"
    )
    .all(q, q);
  return (rows as { id: string; name: string; identifier: string; bus_ids: string; trust_level: string; notes: string }[]).map((r) => ({
    id: r.id,
    name: r.name,
    identifier: r.identifier,
    trust_level: r.trust_level as ContactTrustLevel,
    bus_ids: parseBusIds(r.bus_ids),
    notes: r.notes || "",
  }));
}

export function contactGet(idOrIdentifier: string): ContactWithNote | null {
  const id = String(idOrIdentifier || "").trim();
  const row = getDb()
    .prepare("SELECT id, name, identifier, bus_ids, trust_level, notes FROM contacts WHERE id = ? OR identifier = ?")
    .get(id, id) as { id: string; name: string; identifier: string; bus_ids: string; trust_level: string; notes: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    identifier: row.identifier,
    trust_level: row.trust_level as ContactTrustLevel,
    bus_ids: parseBusIds(row.bus_ids),
    notes: row.notes || "",
  };
}

export function contactCreate(args: {
  name: string;
  identifier: string;
  trust_level?: ContactTrustLevel;
  bus_ids?: string[];
  notes?: string;
}): string {
  const identifier = sanitizeIdentifier(args.identifier);
  if (!identifier) throw new Error("identifier is required");
  const items = contactList();
  if (items.some((e) => e.identifier === identifier)) {
    throw new Error(`Contact with identifier "${identifier}" already exists`);
  }
  const id = randomUUID();
  const busIds = Array.isArray(args.bus_ids) ? args.bus_ids : [];
  const notes = String(args.notes ?? "").trim();
  getDb()
    .prepare(
      "INSERT INTO contacts (id, name, identifier, bus_ids, trust_level, notes) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, (args.name || identifier).trim(), identifier, JSON.stringify(busIds), args.trust_level ?? "normal", notes);
  for (const bid of busIds) resetIdentityAttempts(bid);
  return id;
}

export function contactUpdate(
  idOrIdentifier: string,
  updates: { name?: string; identifier?: string; trust_level?: ContactTrustLevel; bus_ids?: string[]; notes?: string }
): void {
  const entry = contactGet(idOrIdentifier);
  if (!entry) throw new Error(`Contact not found: ${idOrIdentifier}`);

  let identifier = entry.identifier;
  if (updates.identifier != null) {
    const newId = sanitizeIdentifier(updates.identifier);
    if (newId && newId !== identifier) {
      const items = contactList();
      if (items.some((e) => e.identifier === newId && e.id !== entry.id)) {
        throw new Error(`Identifier "${newId}" already in use`);
      }
      identifier = newId;
    }
  }

  const name = updates.name != null ? updates.name.trim() : entry.name;
  const trust_level = updates.trust_level ?? entry.trust_level;
  const bus_ids = updates.bus_ids != null ? updates.bus_ids : entry.bus_ids;
  const notes = updates.notes != null ? updates.notes : entry.notes;

  getDb()
    .prepare("UPDATE contacts SET name = ?, identifier = ?, bus_ids = ?, trust_level = ?, notes = ? WHERE id = ?")
    .run(name, identifier, JSON.stringify(bus_ids), trust_level, notes, entry.id);

  for (const bid of bus_ids) resetIdentityAttempts(bid);
}

export function contactDelete(idOrIdentifier: string): void {
  const entry = contactGet(idOrIdentifier);
  if (!entry) throw new Error(`Contact not found: ${idOrIdentifier}`);
  getDb().prepare("DELETE FROM contacts WHERE id = ?").run(entry.id);
}

/**
 * Resolve contact for (bus_id, sender_email?).
 * - root → contact with identifier "user"
 * - telegram-X → contact with bus_ids containing telegram-X
 * - email-X + sender → contact with identifier=sender and bus_ids containing email-X
 */
export function resolveContact(busId: string, senderEmail?: string): Contact | null {
  const items = contactList();

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

/** Trust level for bus: from contact or default "normal". */
export function getTrustLevelForBus(busId: string, senderEmail?: string): ContactTrustLevel {
  const contact = resolveContact(busId, senderEmail);
  return contact?.trust_level ?? "normal";
}

/** Whether bus is trusted (root). */
export function isBusTrusted(busId: string, senderEmail?: string): boolean {
  return getTrustLevelForBus(busId, senderEmail) === "root";
}

/** Update trust_level of contact that contains this bus_id. */
export function contactUpdateTrustByBusId(busId: string, trust_level: ContactTrustLevel): boolean {
  const contact = resolveContact(busId);
  if (!contact) return false;
  contactUpdate(contact.id, { trust_level });
  return true;
}

export { DEFAULT_IDENTIFIER };
