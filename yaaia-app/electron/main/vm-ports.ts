import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

const YAAIA_DIR = join(homedir(), "yaaia");
const VM_PORT_FILE = join(YAAIA_DIR, "vm.port");

/** Read port from ~/yaaia/vm.port. Returns null if file missing or invalid. */
export function getVmPort(): number | null {
  try {
    if (!existsSync(VM_PORT_FILE)) return null;
    const s = readFileSync(VM_PORT_FILE, "utf-8").trim();
    const p = parseInt(s, 10);
    return Number.isFinite(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/** Check if a port is listening. */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

/** Wait for port file to appear. Returns port or null on timeout. */
export async function waitForPortFile(
  portFile: string,
  timeoutMs: number = 15_000
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (existsSync(portFile)) {
        const s = readFileSync(portFile, "utf-8").trim();
        const p = parseInt(s, 10);
        if (Number.isFinite(p) && p > 0 && p < 65536) return p;
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Read serial bridge port from ~/yaaia/vm-{vmId}-serial.port. Returns null if missing or invalid. */
export function getVmSerialPortFromFile(vmId: string): number | null {
  try {
    const path = join(YAAIA_DIR, `vm-${vmId}-serial.port`);
    if (!existsSync(path)) return null;
    const s = readFileSync(path, "utf-8").trim();
    const p = parseInt(s, 10);
    return Number.isFinite(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

export { VM_PORT_FILE };
