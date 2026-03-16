import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { generate } from "otplib";

const YAAIA_DIR = join(homedir(), "yaaia");
const PASSWORDS_PATH = join(YAAIA_DIR, "passwords.json");

export type PasswordType = "string" | "totp";

export type PasswordEntry = {
  uuid: string;
  description: string;
  type: PasswordType;
  value: string;
};

type PasswordsFile = {
  v?: number;
  items: PasswordEntry[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateDescription(description: string): void {
  const t = description?.trim();
  if (!t) throw new Error("description is required");
}

function ensureUuid(entry: Partial<PasswordEntry> & { description: string; type: PasswordType; value: string }): PasswordEntry {
  const uuid = entry.uuid && UUID_RE.test(entry.uuid) ? entry.uuid : randomUUID();
  return { ...entry, uuid };
}

function savePasswords(items: PasswordEntry[]): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(PASSWORDS_PATH, JSON.stringify({ v: 2, items }, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save passwords:", err);
  }
}

function loadPasswords(): PasswordEntry[] {
  try {
    if (existsSync(PASSWORDS_PATH)) {
      const raw = JSON.parse(readFileSync(PASSWORDS_PATH, "utf-8"));
      if (raw?.items && Array.isArray(raw.items)) {
        const items = raw.items.map((e: Partial<PasswordEntry> & { description?: string; type?: string; value?: string }) => {
          const type = (e.type === "totp" ? "totp" : "string") as PasswordType;
          const description = (e.description ?? "").trim() || "unnamed";
          return ensureUuid({ description, uuid: e.uuid, type, value: e.value ?? "" });
        });
        if (raw.v !== 2) {
          savePasswords(items);
        }
        return items;
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Passwords load failed:", err);
  }
  return [];
}

function findEntry(descriptionOrUuid: string): PasswordEntry | undefined {
  const items = loadPasswords();
  if (UUID_RE.test(descriptionOrUuid)) {
    return items.find((e) => e.uuid === descriptionOrUuid);
  }
  return items.find((e) => e.description === descriptionOrUuid);
}

export function passwordsList(): Omit<PasswordEntry, "value">[] {
  const items = loadPasswords();
  return items.map(({ value: _, ...rest }) => rest);
}

export function passwordsListFull(): PasswordEntry[] {
  return loadPasswords();
}

export async function passwordsGet(idOrUuid: string, raw = false): Promise<string | null> {
  const entry = findEntry(idOrUuid);
  if (!entry) return null;

  const { type, value } = entry;

  if (type === "string") {
    return value;
  }

  if (type === "totp") {
    if (raw) {
      return value;
    }
    try {
      const code = await generate({ secret: value.trim() });
      return code;
    } catch (err) {
      console.warn("[YAAIA] TOTP generation failed:", err);
      return value;
    }
  }

  return value;
}

export function passwordsSet(
  description: string,
  type: PasswordType,
  value: string,
  force = false,
  updateUuid?: string
): string {
  validateDescription(description);
  const items = loadPasswords();
  const desc = description.trim();
  const existingByUuid = updateUuid ? items.find((e) => e.uuid === updateUuid) : undefined;
  const existingByDesc = items.find((e) => e.description === desc && e.uuid !== updateUuid);

  if (existingByDesc && !force) {
    throw new Error(`Password "${desc}" already exists. Use force=true to overwrite.`);
  }

  const uuid = existingByUuid?.uuid ?? randomUUID();
  const entry: PasswordEntry = {
    uuid,
    description: desc,
    type,
    value: value.trim(),
  };

  const uuidsToRemove = new Set<string>();
  if (existingByUuid) uuidsToRemove.add(existingByUuid.uuid);
  if (existingByDesc && existingByDesc.uuid !== uuid) uuidsToRemove.add(existingByDesc.uuid);
  const rest = items.filter((e) => !uuidsToRemove.has(e.uuid));
  savePasswords([...rest, entry]);
  return entry.uuid;
}

export function passwordsDelete(idOrUuid: string): void {
  const entry = findEntry(idOrUuid);
  if (!entry) return;
  const items = loadPasswords().filter((e) => e.uuid !== entry.uuid);
  savePasswords(items);
}

export function passwordsWipe(): void {
  savePasswords([]);
}
