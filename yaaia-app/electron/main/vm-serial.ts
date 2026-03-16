import { createConnection } from "node:net";
import { readFileSync, existsSync, realpathSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { getVmSerialPort } from "./vm-manager.js";
import { getVmPort } from "./vm-ports.js";

const VM_HOST = "127.0.0.1";
const FS_BASE = join(homedir(), "yaaia", "storage", "shared");

/** Strip ANSI/VT escape codes including DEC sequences ([!p;32766H etc), OSC, and progress symbols. */
function stripTerminalControlChars(s: string): string {
  return s
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "") // CSI (incl. DEC private mode [!p...])
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[PX^_][^\x1b\x07]*(?:\x1b\\)?/g, "") // DCS, SOS, PM, APC
    .replace(/[\u2800-\u28ff]/g, "") // Braille spinner
    .replace(/[\u23f5-\u23ff]/g, "") // Media control symbols
    .replace(/\x1b[=\]]/g, ""); // Alt screen, other single-char
}

const MAX_BUFFER = 100_000; // chars to keep

interface SerialSession {
  socket: ReturnType<typeof createConnection>;
  buffer: string;
  resolveConnect: () => void;
  rejectConnect: (err: Error) => void;
}

const sessions = new Map<string, SerialSession>();

function getSession(vmId: string): SerialSession | null {
  return sessions.get(vmId) ?? null;
}

export async function connectVmSerial(vmId: string): Promise<{ ok: boolean; error?: string }> {
  if (sessions.has(vmId)) {
    return { ok: true };
  }
  const vmPort = getVmPort();
  if (vmPort == null) {
    return { ok: false, error: "YaaiaVM not running" };
  }
  const serialPort = await getVmSerialPort(vmId);
  if (serialPort == null) {
    return { ok: false, error: "VM not running or serial bridge not available" };
  }
  return new Promise((resolve) => {
    const socket = createConnection(
      { port: serialPort, host: VM_HOST, family: 4 },
      () => {
        const session: SerialSession = {
          socket,
          buffer: "",
          resolveConnect: () => {},
          rejectConnect: () => {},
        };
        sessions.set(vmId, session);
        socket.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          session.buffer += text;
          if (session.buffer.length > MAX_BUFFER) {
            session.buffer = session.buffer.slice(-MAX_BUFFER);
          }
        });
        socket.on("close", () => sessions.delete(vmId));
        socket.on("error", () => sessions.delete(vmId));
        resolve({ ok: true });
      }
    );
    socket.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

export function readVmSerial(vmId: string, stripAnsiCodes = true): string {
  const session = getSession(vmId);
  if (!session) return "";
  const text = session.buffer;
  session.buffer = "";
  return stripAnsiCodes ? stripTerminalControlChars(text) : text;
}

/**
 * Escape bash special chars so they are sent literally. Skips already-escaped chars.
 * - `!` — history expansion (e.g. hello! → last command)
 * - `` ` `` — command substitution (executes and substitutes output)
 * Note: We do NOT escape `$` or `#` — they are often intentional (variables, comments).
 */
function escapeBashSpecialChars(data: string): string {
  return data
    .replace(/(?<!\\)!/g, "\\!")
    .replace(/(?<!\\)`/g, "\\`");
}

export interface WriteVmSerialOptions {
  /** String to send. Ignored when chars is provided. */
  data?: string;
  /** Stream of characters — each element is one char. Sent raw (no escaping). Use for full control. */
  chars?: string[];
  /** When true (and using data), skip escaping. Use chars for unambiguous character-level control. */
  raw?: boolean;
}

export function writeVmSerial(
  vmId: string,
  options: string | WriteVmSerialOptions
): { ok: boolean; error?: string } {
  const session = getSession(vmId);
  if (!session) {
    return { ok: false, error: "Not connected to VM serial. Call vm_serial_connect first." };
  }

  let toSend: string;
  let applyEscaping: boolean;

  if (typeof options === "string") {
    toSend = options;
    applyEscaping = true;
  } else if (options.chars != null && options.chars.length > 0) {
    toSend = options.chars.join("");
    applyEscaping = false;
  } else if (options.data != null) {
    toSend = options.data;
    applyEscaping = !options.raw;
  } else {
    return { ok: false, error: "data or chars is required" };
  }

  try {
    const out = applyEscaping ? escapeBashSpecialChars(toSend) : toSend;
    session.socket.write(out, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function disconnectVmSerial(vmId: string): void {
  const session = sessions.get(vmId);
  if (session) {
    session.socket.destroy();
    sessions.delete(vmId);
  }
}

function getRealFsBase(): string {
  mkdirSync(FS_BASE, { recursive: true });
  return realpathSync(FS_BASE);
}

function isWithinRoot(realPath: string, realBase: string): boolean {
  return realPath === realBase || realPath.startsWith(realBase + sep);
}

/** Resolve path relative to fs root. No traversal. Rejects symlink escape. */
function resolveFsPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid path: no absolute paths or traversal allowed");
  }
  const resolved = join(FS_BASE, normalized);
  if (!resolved.startsWith(FS_BASE)) {
    throw new Error("Invalid path: outside shared root");
  }
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const realBase = getRealFsBase();
    if (!isWithinRoot(real, realBase)) {
      throw new Error("Invalid path: symlink escape");
    }
  }
  return resolved;
}

/**
 * Read file from ~/yaaia/storage/shared and send content raw to VM.
 * Use for large bash scripts — write to fs first, then send_file. No string escaping.
 */
export function sendFileToVmSerial(vmId: string, path: string): { ok: boolean; error?: string } {
  const session = getSession(vmId);
  if (!session) {
    return { ok: false, error: "Not connected to VM serial. Call vm_serial.connect first." };
  }
  try {
    const absPath = resolveFsPath(path);
    const content = readFileSync(absPath, "utf-8");
    return writeVmSerial(vmId, { data: content, raw: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
