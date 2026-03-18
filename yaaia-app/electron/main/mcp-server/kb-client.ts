/**
 * Storage client: file operations under ~/yaaia/storage.
 * Plain markdown files only. Used by message-db.
 */

import { app } from "electron";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, existsSync, copyFileSync } from "node:fs";

const YAAIA_DIR = join(homedir(), "yaaia");
const STORAGE_ROOT = join(YAAIA_DIR, "storage");
const ALLOWED_EXT = [".md", ".qmd"];

/** Ensure directory exists under STORAGE_ROOT. Creates parent dirs recursively. */
export function kbEnsureDir(relativePath: string): void {
  const full = resolveKbPath(relativePath);
  mkdirSync(full, { recursive: true });
}

/** Resolve path under STORAGE_ROOT. Throws if path escapes (traversal). */
export function resolveKbPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const resolved = resolve(STORAGE_ROOT, normalized);
  const storageResolved = resolve(STORAGE_ROOT);
  if (!resolved.startsWith(storageResolved)) {
    throw new Error("Invalid path: outside storage root");
  }
  return resolved;
}

/** Ensure path is under STORAGE_ROOT and has allowed extension for write. */
function ensureAllowedExt(path: string): void {
  const ext = path.slice(path.lastIndexOf("."));
  if (!ALLOWED_EXT.includes(ext.toLowerCase())) {
    throw new Error(`Only .md and .qmd files allowed, got: ${ext || "(no extension)"}`);
  }
}

/** Normalize collection name for use as folder path (spaces -> underscores). */
function collectionNameToPath(name: string): string {
  return name.replace(/\s+/g, "_").replace(/\/+/g, "_").replace(/^_|_$/g, "") || name;
}

export function getStorageRoot(): string {
  return STORAGE_ROOT;
}

export function kbRead(relativePath: string): string {
  const full = resolveKbPath(relativePath);
  if (!existsSync(full)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  const st = statSync(full);
  if (st.isDirectory()) {
    throw new Error("Cannot read directory");
  }
  ensureAllowedExt(relativePath);
  return readFileSync(full, "utf-8");
}

export function kbWrite(relativePath: string, content: string): void {
  const full = resolveKbPath(relativePath);
  ensureAllowedExt(relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/**
 * Replace lines from_line to to_line (inclusive, 0-based) with content.
 * to_line=-1 means end of file. Use from_line=last line index, to_line=-1 to append.
 */
export function kbReplace(relativePath: string, fromLine: number, toLine: number, content: string): void {
  const full = resolveKbPath(relativePath);
  if (!existsSync(full)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  ensureAllowedExt(relativePath);
  const existing = readFileSync(full, "utf-8");
  const lines = existing.split("\n");
  const to = toLine < 0 ? lines.length - 1 : Math.min(toLine, lines.length - 1);
  const from = Math.max(0, fromLine);
  const newLines = content.split("\n");
  let result: string[];
  if (from > to) {
    result = [...lines.slice(0, from), ...newLines, ...lines.slice(from)];
  } else {
    result = [...lines.slice(0, from), ...newLines, ...lines.slice(to + 1)];
  }
  writeFileSync(full, result.join("\n"), "utf-8");
}

export function kbDelete(relativePath: string): void {
  const full = resolveKbPath(relativePath);
  if (!existsSync(full)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  const st = statSync(full);
  if (st.isDirectory()) {
    throw new Error("Use kb.list to inspect. Deleting directories not supported.");
  }
  ensureAllowedExt(relativePath);
  unlinkSync(full);
}

export function kbList(relativePath: string, recursive: boolean): string[] {
  const full = resolveKbPath(relativePath || ".");
  if (!existsSync(full)) return [];
  const st = statSync(full);
  if (!st.isDirectory()) return [relativePath || full];

  function walk(dir: string, prefix: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (recursive) {
          out.push(...walk(join(dir, e.name), rel));
        } else {
          out.push(rel + "/");
        }
      } else {
        out.push(rel);
      }
    }
    return out.sort();
  }

  return walk(full, relativePath || "");
}

/** Build full path (relative to STORAGE_ROOT) from collection + path. Path is relative to collection. Empty path = collection root. */
export function buildKbPathFromCollection(collection: string, path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const collPath = collectionNameToPath(collection);
  if (!collPath) return normalized;
  return normalized ? `${collPath}/${normalized}` : collPath;
}

/** Ensure collection directory exists under storage. No indexing — just mkdir. */
export function kbEnsureCollection(collectionName: string): void {
  const pathRel = collectionNameToPath(collectionName);
  const fullPath = resolve(STORAGE_ROOT, pathRel);
  mkdirSync(fullPath, { recursive: true });
}

/** Ensure storage/history, storage/shared, storage/shared/skills exist. */
export function ensureStorageDirs(): void {
  for (const sub of ["history", "shared", "shared/skills"]) {
    mkdirSync(join(STORAGE_ROOT, sub), { recursive: true });
  }
}

/** Copy yaaia-vm-agent from app resources to shared if present. VM needs it in shared for virtiofs. */
export function ensureVmAgentInShared(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const resourcesDir = app.isPackaged
    ? join(process.resourcesPath)
    : join(__dirname, "..", "..", "resources");
  const src = join(resourcesDir, "yaaia-vm-agent");
  const sharedDir = join(STORAGE_ROOT, "shared");
  const dest = join(sharedDir, "yaaia-vm-agent");
  if (existsSync(src)) {
    mkdirSync(sharedDir, { recursive: true });
    try {
      copyFileSync(src, dest);
    } catch {
      /* ignore copy errors */
    }
  }
}
