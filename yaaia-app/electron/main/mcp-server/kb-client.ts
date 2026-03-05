/**
 * Knowledge Base client: QMD MCP + file operations.
 * All storage under ~/yaaia (kb content + qmd cache/config).
 */

import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const KB_ROOT = join(YAAIA_DIR, "kb");
const QMD_DIR = join(YAAIA_DIR, "qmd");
const QMD_INDEX = "yaaia";

/** Strip ANSI escape codes and progress symbols (spinner, cursor control) from qmd CLI output. */
function stripProgressOutput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u2800-\u28ff]/g, "") // Braille spinner chars
    .replace(/[\u23f5-\u23ff]/g, "") // Media control symbols (⏵ etc)
    .trim();
}

const ALLOWED_EXT = [".md", ".qmd"];

function getQmdEnv(): Record<string, string> {
  // mcp.js calls createStore() with no args → getDefaultDbPath() defaults to "index".
  // INDEX_PATH forces the correct DB (store ignores --index when creating its own store).
  const qmdDbPath = join(QMD_DIR, `${QMD_INDEX}.sqlite`);
  return {
    ...process.env,
    XDG_CACHE_HOME: YAAIA_DIR, // ~/yaaia/qmd/models, ~/yaaia/qmd/*.sqlite
    XDG_CONFIG_HOME: YAAIA_DIR, // ~/yaaia/qmd/*.yml (qmd appends "qmd" subdir)
    INDEX_PATH: qmdDbPath, // mcp.js createStore() uses this; otherwise defaults to index.sqlite
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function getQmdArgs(...args: string[]): string[] {
  return ["--index", QMD_INDEX, ...args];
}

/** Resolve path under KB_ROOT. Throws if path escapes (traversal). */
export function resolveKbPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const resolved = resolve(KB_ROOT, normalized);
  const kbRootResolved = resolve(KB_ROOT);
  if (!resolved.startsWith(kbRootResolved)) {
    throw new Error("Invalid path: outside KB root");
  }
  return resolved;
}

/** Ensure path is under KB_ROOT and has allowed extension for write. */
function ensureAllowedExt(path: string): void {
  const ext = path.slice(path.lastIndexOf("."));
  if (!ALLOWED_EXT.includes(ext.toLowerCase())) {
    throw new Error(`Only .md and .qmd files allowed, got: ${ext || "(no extension)"}`);
  }
}

let kbClient: Client | null = null;
let kbTransport: StdioClientTransport | null = null;

export async function connectKbMcp(
  onProgress?: (step: string) => void
): Promise<void> {
  console.log(`${QMD_LOG_PREFIX} connectKbMcp: starting`);
  if (kbClient) {
    await kbClient.close();
    kbClient = null;
    kbTransport = null;
  }

  mkdirSync(KB_ROOT, { recursive: true });
  mkdirSync(QMD_DIR, { recursive: true });
  console.log(`${QMD_LOG_PREFIX} KB_ROOT=${KB_ROOT} QMD_DIR=${QMD_DIR}`);

  const require = createRequire(import.meta.url);
  const qmdPkgPath = require.resolve("@tobilu/qmd/package.json");
  const qmdPath = join(dirname(qmdPkgPath), "dist", "qmd.js");

  const mcpArgs = [qmdPath, ...getQmdArgs("mcp")];
  const qmdEnv = getQmdEnv();
  console.log(`${QMD_LOG_PREFIX} MCP spawn: ${process.execPath} ${mcpArgs.join(" ")}`);
  console.log(`${QMD_LOG_PREFIX} Env: INDEX_PATH=${qmdEnv.INDEX_PATH} XDG_CACHE_HOME=${qmdEnv.XDG_CACHE_HOME}`);

  kbTransport = new StdioClientTransport({
    command: process.execPath,
    args: mcpArgs,
    env: qmdEnv,
  });

  kbClient = new Client(
    { name: "yaaia-kb-proxy", version: "1.0.0" },
    { capabilities: {} }
  );

  await kbClient.connect(kbTransport);
  console.log(`${QMD_LOG_PREFIX} MCP connected`);

  onProgress?.("Indexing knowledge base...");
  console.log(`${QMD_LOG_PREFIX} Running qmd update...`);
  await runQmdCli(["update"], onProgress);
  console.log(`${QMD_LOG_PREFIX} Running qmd embed...`);
  await runQmdCli(["embed"], onProgress);
  onProgress?.("Downloading and warming up search models (may take a few minutes)...");
  console.log(`${QMD_LOG_PREFIX} Running qmd query warmup (triggers reranker + query-expansion model download)...`);
  try {
    await runQmdCli(["query", "warmup", "-n", "1"], onProgress);
  } catch (err) {
    console.log(`${QMD_LOG_PREFIX} Warmup query failed (may be empty index):`, err instanceof Error ? err.message : err);
  }
  console.log(`${QMD_LOG_PREFIX} connectKbMcp: done`);
}

export async function disconnectKbMcp(): Promise<void> {
  if (kbTransport) {
    await kbTransport.close();
    kbTransport = null;
  }
  kbClient = null;
}

export interface KbTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export async function listKbTools(): Promise<KbTool[]> {
  if (!kbClient) throw new Error("KB MCP not connected");
  const result = await kbClient.listTools();
  return result.tools as KbTool[];
}

export async function callKbTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text?: string }[] }> {
  if (!kbClient) throw new Error("KB MCP not connected");
  console.log(`${QMD_LOG_PREFIX} callTool: ${name}`, JSON.stringify(args));
  const result = await kbClient.callTool({ name, arguments: args });
  const text = (result as { content?: { type: string; text?: string }[] }).content
    ?.filter((c) => c.type === "text" && c.text)
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .slice(0, 200);
  console.log(`${QMD_LOG_PREFIX} callTool ${name} result:`, text ? `"${text}${(text?.length ?? 0) >= 200 ? "..." : ""}"` : "(empty)");
  return result as { content: { type: string; text?: string }[] };
}

const QMD_LOG_PREFIX = "[YAAIA KB/QMD]";

/** Normalize path to match QMD's handelize: underscores->hyphens, lowercase. Preserves extension. */
export function normalizeQmdPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments
    .map((seg, i) => {
      const isLast = i === segments.length - 1;
      const extMatch = seg.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1] : "";
      const name = ext ? seg.slice(0, -ext.length) : seg;
      const cleaned = name
        .replace(/[^\p{L}\p{N}$]+/gu, "-")
        .replace(/^-+|-+$/g, "");
      return (cleaned || name) + ext;
    })
    .join("/")
    .toLowerCase();
}

/** Run qmd CLI command. onProgress receives last line of stdout. */
export async function runQmdCli(
  args: string[],
  onProgress?: (line: string) => void
): Promise<string> {
  return runQmdCliInternal(args, false, onProgress);
}

/** Run qmd CLI and return full stdout (for status, collection list, etc.). */
export async function runQmdCliFullOutput(args: string[]): Promise<string> {
  return runQmdCliInternal(args, true);
}

async function runQmdCliInternal(
  args: string[],
  fullOutput: boolean,
  onProgress?: (line: string) => void
): Promise<string> {
  const require = createRequire(import.meta.url);
  const qmdPkgPath = require.resolve("@tobilu/qmd/package.json");
  const qmdPath = join(dirname(qmdPkgPath), "dist", "qmd.js");
  const fullArgs = [qmdPath, ...getQmdArgs(...args)];
  const env = getQmdEnv();

  console.log(`${QMD_LOG_PREFIX} CLI: ${process.execPath} ${fullArgs.join(" ")}`);
  console.log(`${QMD_LOG_PREFIX} Env: XDG_CACHE_HOME=${env.XDG_CACHE_HOME} XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`);

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, fullArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stdoutLines: string[] = [];
    let lastLine = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = stripProgressOutput(chunk.toString("utf-8"));
      if (fullOutput) stdoutChunks.push(text);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      stdoutLines.push(...lines);
      if (lines.length > 0) {
        lastLine = lines[lines.length - 1];
        onProgress?.(lastLine);
      }
    });

    const stderr: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = stripProgressOutput(chunk.toString("utf-8"));
      stderr.push(s);
      if (s) console.log(`${QMD_LOG_PREFIX} stderr:`, s);
    });

    proc.on("close", (code, signal) => {
      if (stdoutLines.length > 0 && !fullOutput) {
        console.log(`${QMD_LOG_PREFIX} stdout:`, stdoutLines.map(stripProgressOutput).join(" | "));
      }
      console.log(`${QMD_LOG_PREFIX} exit: code=${code} signal=${signal}`);
      if (code === 0) {
        resolvePromise(fullOutput ? stdoutChunks.join("") : lastLine);
      } else {
        const errMsg = stderr.join("").trim() || `qmd exited with code ${code}`;
        console.error(`${QMD_LOG_PREFIX} FAILED:`, errMsg);
        reject(new Error(errMsg));
      }
    });

    proc.on("error", (err) => {
      console.error(`${QMD_LOG_PREFIX} spawn error:`, err);
      reject(err);
    });
  });
}

export function getKbRoot(): string {
  return KB_ROOT;
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

export function kbDelete(relativePath: string): void {
  const full = resolveKbPath(relativePath);
  if (!existsSync(full)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  const st = statSync(full);
  if (st.isDirectory()) {
    throw new Error("Use kb__list to inspect. Deleting directories not supported.");
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

export async function kbCollectionAdd(name: string, subpath?: string): Promise<string> {
  const pathRel = subpath ? subpath.replace(/\\/g, "/").replace(/\/+/g, "/").trim() : name;
  if (pathRel.startsWith("/") || pathRel.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const fullPath = resolve(KB_ROOT, pathRel);
  console.log(`${QMD_LOG_PREFIX} kbCollectionAdd: name=${name} path=${fullPath}`);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
    console.log(`${QMD_LOG_PREFIX} Created directory ${fullPath}`);
  }
  await runQmdCli(["collection", "add", fullPath, "--name", name]);
  return `Collection "${name}" added at ${fullPath}`;
}

export async function kbCollectionList(): Promise<string> {
  return runQmdCliFullOutput(["collection", "list"]);
}

export async function kbCollectionRemove(name: string): Promise<string> {
  await runQmdCli(["collection", "remove", name]);
  return `Collection "${name}" removed`;
}

/** Normalize collection name for use as folder path (spaces -> underscores). */
function collectionNameToPath(name: string): string {
  return name.replace(/\s+/g, "_").replace(/\/+/g, "_").replace(/^_|_$/g, "") || name;
}

/** Build full path (relative to KB_ROOT) from collection + path. Path is relative to collection. Empty path = collection root. */
export function buildKbPathFromCollection(collection: string, path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const collPath = collectionNameToPath(collection);
  if (!collPath) return normalized;
  return normalized ? `${collPath}/${normalized}` : collPath;
}

/** Check if collection already exists in QMD config. */
async function kbCollectionExists(collectionName: string): Promise<boolean> {
  const listOutput = await runQmdCliFullOutput(["collection", "list"]);
  // Output contains "  collectionname (qmd://collectionname/)" for each collection
  return listOutput.includes(`(qmd://${collectionName}/)`);
}

/** Ensure collection exists; create it if missing. Skips if already exists. */
export async function kbEnsureCollection(collectionName: string): Promise<void> {
  if (await kbCollectionExists(collectionName)) {
    return;
  }
  const pathRel = collectionNameToPath(collectionName);
  const fullPath = resolve(KB_ROOT, pathRel);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
    console.log(`${QMD_LOG_PREFIX} Created directory ${fullPath} for collection "${collectionName}"`);
  }
  await runQmdCli(["collection", "add", fullPath, "--name", collectionName]);
}
