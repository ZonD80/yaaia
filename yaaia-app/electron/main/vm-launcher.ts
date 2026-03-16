import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { waitForPortFile, getVmPort, VM_PORT_FILE } from "./vm-ports.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;

function getYaaiaVmDir(): string {
  if (isPackaged) {
    return process.resourcesPath;
  }
  // Dev: __dirname = dist-electron/main, so ../../resources = project root resources
  return join(__dirname, "..", "..", "resources");
}

function getYaaiaVmBinary(): string | null {
  if (isPackaged) {
    const packagedPath = join(process.resourcesPath, "YaaiaVM");
    if (existsSync(packagedPath)) return packagedPath;
    return null;
  }
  const resourcesDir = join(__dirname, "..", "..", "resources");
  const binaryPath = join(resourcesDir, "YaaiaVM");
  if (existsSync(binaryPath)) return binaryPath;
  return null;
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

let yaaiaVmProcess: ChildProcess | null = null;

export async function startYaaiaVm(options?: {
  onProgress?: (message: string) => void;
}): Promise<{ ok: boolean; message: string }> {
  if (yaaiaVmProcess) {
    return { ok: true, message: "YaaiaVM already running" };
  }

  const existingPort = getVmPort();
  if (existingPort != null) {
    const alreadyRunning = await isPortInUse(existingPort);
    if (alreadyRunning) {
      return { ok: true, message: "YaaiaVM already running" };
    }
  }

  const binary = getYaaiaVmBinary();
  const vmDir = getYaaiaVmDir();

  if (!binary || !existsSync(binary)) {
    const debugMsg = `YaaiaVM binary not found. Build with: cd yaaia-vm && swift build -c release, then copy .build/arm64-apple-macosx/release/YaaiaVM to resources/`;
    return { ok: false, message: debugMsg };
  }

  const env: Record<string, string> = { ...process.env, YAAIA_PARENT_PID: String(process.pid) };
  const onProgress = options?.onProgress;

  try {
    onProgress?.("Spawning YaaiaVM...");
    if (existsSync(VM_PORT_FILE)) {
      try {
        unlinkSync(VM_PORT_FILE);
      } catch {
        /* ignore */
      }
    }
    yaaiaVmProcess = spawn(binary, [], {
      cwd: vmDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env,
    });
    yaaiaVmProcess.stdout?.on("data", (d) => process.stdout.write(`[YaaiaVM] ${d}`));
    yaaiaVmProcess.stderr?.on("data", (d) => process.stderr.write(`[YaaiaVM] ${d}`));
    yaaiaVmProcess.unref();
    yaaiaVmProcess.on("error", (err) => console.error("[YAAIA] YaaiaVM error:", err));
    yaaiaVmProcess.on("exit", (code) => {
      yaaiaVmProcess = null;
    });
    onProgress?.("Waiting for YaaiaVM port (up to 15s)...");
    const port = await waitForPortFile(VM_PORT_FILE, 15_000);
    if (port == null) {
      return { ok: false, message: "YaaiaVM started but vm.port not written after 15s" };
    }
    onProgress?.(`YaaiaVM port ${port} found, verifying...`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await isPortInUse(port);
      if (ready) {
        return { ok: true, message: "YaaiaVM started" };
      }
    }
    return { ok: false, message: `YaaiaVM port not ready after 10s` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "YaaiaVM spawn failed",
    };
  }
}

export function stopYaaiaVm(): void {
  if (yaaiaVmProcess) {
    yaaiaVmProcess.kill("SIGTERM");
    yaaiaVmProcess = null;
  }
}
