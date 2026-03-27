/**
 * Spawns the local yaaia-tg-gateway binary when the default URL is down.
 * Set YAAIA_TG_GATEWAY_NO_SPAWN=1 to disable, or use a custom YAAIA_TG_GATEWAY_URL (non-default) to use an external gateway only.
 */

import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_ADDR = "127.0.0.1:37567";
const DEFAULT_URL = `http://${DEFAULT_ADDR}`;

let child: ChildProcess | null = null;
let weSpawned = false;

function resourcesDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return join(__dirname, "..", "..", "resources");
}

export function getTelegramGatewayBinaryPath(): string | null {
  const p = join(resourcesDir(), "yaaia-tg-gateway");
  return existsSync(p) ? p : null;
}

function normalizedGatewayUrl(): string {
  return (process.env.YAAIA_TG_GATEWAY_URL ?? DEFAULT_URL).replace(/\/$/, "");
}

function isDefaultGatewayUrl(): boolean {
  const u = normalizedGatewayUrl();
  return u === DEFAULT_URL || u === "http://127.0.0.1:37567";
}

async function healthOk(base: string): Promise<boolean> {
  const tryOnce = async (headers?: HeadersInit) => {
    try {
      const r = await fetch(`${base}/v1/health`, { headers });
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await tryOnce()) return true;
  const t = process.env.YAAIA_TG_GATEWAY_TOKEN?.trim();
  if (t) {
    return tryOnce({ Authorization: `Bearer ${t}` });
  }
  return false;
}

/**
 * Ensures a gateway responds at YAAIA_TG_GATEWAY_URL (default http://127.0.0.1:37567).
 * When the default URL is used and nothing is listening, spawns `resources/yaaia-tg-gateway`,
 * sets YAAIA_TG_GATEWAY_TOKEN and YAAIA_TG_GATEWAY_ADDR for this process.
 */
export async function startTelegramGatewayIfNeeded(): Promise<void> {
  if (process.env.YAAIA_TG_GATEWAY_NO_SPAWN === "1") {
    return;
  }
  const base = normalizedGatewayUrl();
  if (!isDefaultGatewayUrl()) {
    if (!(await healthOk(base))) {
      console.warn(
        `[YAAIA] Telegram gateway not reachable at ${base}. Start it manually or clear YAAIA_TG_GATEWAY_URL to use the bundled binary.`
      );
    }
    return;
  }
  if (await healthOk(base)) {
    if (!process.env.YAAIA_TG_GATEWAY_URL) {
      process.env.YAAIA_TG_GATEWAY_URL = DEFAULT_URL;
    }
    return;
  }

  const bin = getTelegramGatewayBinaryPath();
  if (!bin) {
    console.warn(
      "[YAAIA] yaaia-tg-gateway not found under resources/. Build: npm run build:telegram-gateway — or run the gateway manually."
    );
    return;
  }

  const token = randomBytes(24).toString("hex");
  process.env.YAAIA_TG_GATEWAY_TOKEN = token;
  process.env.YAAIA_TG_GATEWAY_URL = DEFAULT_URL;
  process.env.YAAIA_TG_GATEWAY_ADDR = DEFAULT_ADDR;

  try {
    child = spawn(bin, [], {
      env: {
        ...process.env,
        YAAIA_TG_GATEWAY_ADDR: DEFAULT_ADDR,
        YAAIA_TG_GATEWAY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    weSpawned = true;
    child.stdout?.on("data", (d) => process.stdout.write(`[tg-gateway] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[tg-gateway] ${d}`));
    child.on("error", (err) => console.error("[YAAIA] tg-gateway spawn error:", err));
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[YAAIA] tg-gateway exited with code ${code}`);
      }
      child = null;
      weSpawned = false;
    });
  } catch (err) {
    console.error("[YAAIA] Failed to spawn tg-gateway:", err);
    return;
  }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthOk(DEFAULT_URL)) {
      return;
    }
  }
  console.warn("[YAAIA] tg-gateway did not become healthy within 6s.");
}

export function stopTelegramGatewayIfSpawned(): void {
  if (weSpawned && child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    child = null;
    weSpawned = false;
  }
}
