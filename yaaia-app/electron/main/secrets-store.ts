import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { generate } from "otplib";

const YAAIA_DIR = join(homedir(), "yaaia");
const SECRETS_PATH = join(YAAIA_DIR, "secrets.json");

export type SecretEntry = {
  id: string;
  detailed_description: string;
  first_factor: string;
  first_factor_type: string;
  value: string;
  totp_secret?: string;
};

export type SecretsGetResult =
  | { value: string }
  | { value: string; totp_code: string; totp_expires_in_seconds: number };

type SecretsFile = {
  v?: number;
  items: SecretEntry[];
};

function loadSecrets(): SecretEntry[] {
  try {
    if (existsSync(SECRETS_PATH)) {
      const raw = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
      if (raw?.items && Array.isArray(raw.items)) {
        return raw.items;
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const items: SecretEntry[] = [];
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string") {
            items.push({
              id: randomUUID(),
              detailed_description: k,
              first_factor: "",
              first_factor_type: "legacy",
              value: v,
            });
          }
        }
        if (items.length > 0) {
          saveSecrets(items);
          return items;
        }
      }
    }
  } catch (err) {
    console.warn("[YAAIA] Secrets load failed:", err);
  }
  return [];
}

function saveSecrets(items: SecretEntry[]): void {
  try {
    mkdirSync(YAAIA_DIR, { recursive: true });
    writeFileSync(SECRETS_PATH, JSON.stringify({ v: 2, items }, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save secrets:", err);
  }
}

export function validateDetailedDescription(d: string): void {
  if (d.includes(",")) {
    throw new Error("Detailed description must not contain commas");
  }
}

export function secretsList(): (Omit<SecretEntry, "value" | "totp_secret"> & { has_totp?: boolean })[] {
  const items = loadSecrets();
  return items.map(({ value: _, totp_secret, ...rest }) => ({
    ...rest,
    has_totp: !!totp_secret,
  }));
}

export function secretsListFull(): SecretEntry[] {
  return loadSecrets();
}

export async function secretsGet(id: string): Promise<string | SecretsGetResult | null> {
  const items = loadSecrets();
  const entry = items.find((e) => e.id === id);
  if (!entry) return null;
  const { value, totp_secret } = entry;
  if (!totp_secret?.trim()) {
    return value;
  }
  try {
    const totp_code = await generate({ secret: totp_secret.trim() });
    const epoch = Math.floor(Date.now() / 1000);
    const totp_expires_in_seconds = 30 - (epoch % 30);
    return { value, totp_code, totp_expires_in_seconds };
  } catch (err) {
    console.warn("[YAAIA] TOTP generation failed:", err);
    return value;
  }
}

export function secretsSet(
  detailed_description: string,
  first_factor: string,
  first_factor_type: string,
  value: string,
  force: boolean,
  totp_secret?: string
): string {
  validateDetailedDescription(detailed_description);
  const items = loadSecrets();
  const existing = items.find(
    (e) => e.detailed_description === detailed_description && e.first_factor === first_factor
  );
  if (existing && !force) {
    throw new Error(
      `Secret "${detailed_description}" for "${first_factor}" already exists. Use force=true to overwrite.`
    );
  }
  const entry: SecretEntry = {
    id: existing?.id ?? randomUUID(),
    detailed_description,
    first_factor,
    first_factor_type,
    value,
    totp_secret: totp_secret?.trim() || undefined,
  };
  const rest = items.filter((e) => e.id !== entry.id);
  saveSecrets([...rest, entry]);
  return entry.id;
}

export function secretsDelete(id: string): void {
  const items = loadSecrets().filter((e) => e.id !== id);
  saveSecrets(items);
}

export function secretsWipe(): void {
  saveSecrets([]);
}
