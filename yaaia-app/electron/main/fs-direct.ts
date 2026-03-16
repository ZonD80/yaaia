/**
 * Direct filesystem operations for eval runtime.
 * Paths relative to ~/yaaia/storage (fs root). Use shared/ for VM-shared files.
 */

import { join, sep } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";

const FS_BASE = join(homedir(), "yaaia", "storage");

function getRealFsBase(): string {
  mkdirSync(FS_BASE, { recursive: true });
  return realpathSync(FS_BASE);
}

function isWithinRoot(realPath: string, realBase: string): boolean {
  return realPath === realBase || realPath.startsWith(realBase + sep);
}

function resolvePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const resolved = join(FS_BASE, normalized);
  if (!resolved.startsWith(FS_BASE)) {
    throw new Error("Invalid path: outside storage root");
  }
  return resolved;
}

/** Verify resolved path (or its nearest existing ancestor) stays within fs root after symlink resolution. */
function ensureWithinRoot(resolved: string): void {
  const realBase = getRealFsBase();
  let current = resolved;
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      if (!isWithinRoot(real, realBase)) {
        throw new Error("Invalid path: symlink escape");
      }
      return;
    }
    const parent = join(current, "..");
    if (parent === current) throw new Error("Invalid path: outside storage root");
    current = parent;
  }
}

export interface FsResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): FsResult {
  return { content: [{ type: "text", text }], isError };
}

export async function callFsToolDirect(
  name: string,
  args: Record<string, unknown>
): Promise<FsResult> {
  try {
    switch (name) {
      case "read_file": {
        const path = String(args.path ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        ensureWithinRoot(full);
        const content = readFileSync(full, "utf-8");
        return textResult(content);
      }
      case "write_file": {
        const path = String(args.path ?? "").trim();
        const content = String(args.content ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        ensureWithinRoot(join(full, ".."));
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf-8");
        return textResult(`Written ${path}`);
      }
      case "append_file": {
        const path = String(args.path ?? "").trim();
        const content = String(args.content ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        ensureWithinRoot(join(full, ".."));
        mkdirSync(join(full, ".."), { recursive: true });
        appendFileSync(full, content, "utf-8");
        return textResult(`Appended to ${path}`);
      }
      case "replace_file": {
        const path = String(args.path ?? "").trim();
        const content = String(args.content ?? "").trim();
        const fromLine = typeof args.from_line === "number" ? args.from_line : 0;
        const toLine = typeof args.to_line === "number" ? args.to_line : -1;
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        if (!existsSync(full)) return textResult(`Error: File not found: ${path}`, true);
        ensureWithinRoot(full);
        const existing = readFileSync(full, "utf-8");
        const lines = existing.split("\n");
        const to = toLine < 0 ? lines.length - 1 : Math.min(toLine, lines.length - 1);
        const from = Math.max(0, fromLine);
        const newLines = content.split("\n");
        const result =
          from > to
            ? [...lines.slice(0, from), ...newLines, ...lines.slice(from)]
            : [...lines.slice(0, from), ...newLines, ...lines.slice(to + 1)];
        writeFileSync(full, result.join("\n"), "utf-8");
        return textResult(`Replaced lines ${from}-${to} in ${path}`);
      }
      case "update_file": {
        const path = String(args.path ?? "").trim();
        const content = String(args.content ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        if (!existsSync(full)) return textResult(`Error: File not found: ${path}`, true);
        ensureWithinRoot(full);
        writeFileSync(full, content, "utf-8");
        return textResult(`Updated ${path}`);
      }
      case "list_files": {
        const path = String(args.path ?? "").trim() || ".";
        const full = resolvePath(path);
        if (!existsSync(full)) return textResult(`Error: Path not found: ${path}`, true);
        ensureWithinRoot(full);
        const stat = statSync(full);
        if (!stat.isDirectory()) return textResult(`Error: Not a directory: ${path}`, true);
        const entries = readdirSync(full, { withFileTypes: true });
        const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return textResult(names.join("\n") || "(empty)");
      }
      case "delete_file": {
        const path = String(args.path ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        if (!existsSync(full)) return textResult(`Error: File not found: ${path}`, true);
        ensureWithinRoot(full);
        const stat = statSync(full);
        if (stat.isDirectory()) return textResult(`Error: Use delete_directory for directories`, true);
        unlinkSync(full);
        return textResult(`Deleted ${path}`);
      }
      case "delete_directory": {
        const path = String(args.path ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        if (!existsSync(full)) return textResult(`Error: Path not found: ${path}`, true);
        ensureWithinRoot(full);
        rmdirSync(full, { recursive: true });
        return textResult(`Deleted ${path}`);
      }
      case "create_directory": {
        const path = String(args.path ?? "").trim();
        if (!path) return textResult("Error: path is required", true);
        const full = resolvePath(path);
        ensureWithinRoot(join(full, ".."));
        mkdirSync(full, { recursive: true });
        return textResult(`Created ${path}`);
      }
      case "move_path": {
        const source = String(args.source ?? "").trim();
        const destination = String(args.destination ?? "").trim();
        if (!source || !destination) return textResult("Error: source and destination required", true);
        const srcFull = resolvePath(source);
        const dstFull = resolvePath(destination);
        if (!existsSync(srcFull)) return textResult(`Error: Source not found: ${source}`, true);
        ensureWithinRoot(srcFull);
        ensureWithinRoot(join(dstFull, ".."));
        renameSync(srcFull, dstFull);
        return textResult(`Moved ${source} to ${destination}`);
      }
      case "copy_path": {
        const source = String(args.source ?? "").trim();
        const destination = String(args.destination ?? "").trim();
        if (!source || !destination) return textResult("Error: source and destination required", true);
        const srcFull = resolvePath(source);
        const dstFull = resolvePath(destination);
        if (!existsSync(srcFull)) return textResult(`Error: Source not found: ${source}`, true);
        ensureWithinRoot(srcFull);
        ensureWithinRoot(join(dstFull, ".."));
        const stat = statSync(srcFull);
        if (stat.isDirectory()) return textResult("Error: copy_path does not support directories", true);
        mkdirSync(join(dstFull, ".."), { recursive: true });
        copyFileSync(srcFull, dstFull);
        return textResult(`Copied ${source} to ${destination}`);
      }
      default:
        return textResult(`Error: Unknown fs tool: ${name}`, true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
  }
}
