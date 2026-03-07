import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import WebSocket from "ws";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { platform } from "node:os";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { startMcpServer, getMcpServerPort, stopChromeMcp, stopKbMcp, stopMailClient } from "./mcp-server/index.js";
import { startAgent, stopAgent, sendMessage, requestAgentAbort, setPendingInjectMessage } from "./ai-agent/index.js";
import { deliverUserReply } from "./ask-user-bridge.js";
import {
  secretsWipe,
  secretsListFull,
  secretsSet,
  secretsDelete,
  validateDetailedDescription as validateSecretsDesc,
} from "./secrets-store.js";
import {
  agentConfigWipe,
  agentConfigList,
  agentConfigSet,
  agentConfigDelete,
  validateDetailedDescription as validateConfigDesc,
} from "./agent-config-store.js";
import * as recipeStore from "./recipe-store.js";
import { kbList, kbRead, kbWrite, kbDelete, runQmdCli } from "./mcp-server/kb-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const YAAIA_DIR = join(homedir(), "yaaia");
const APP_DATA_DIR = join(YAAIA_DIR, "appData");
const AGENT_DATA_DIR = join(YAAIA_DIR, "agentData");
const CONFIG_PATH = join(APP_DATA_DIR, "config.json");

const AGENT_BROWSER_DEBUG_PORT = 9222;

/** Bring main window to front. Uses app.focus({ steal: true }) on macOS to reclaim focus from Chrome. */
function refocusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  app.focus({ steal: true });
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
}

function safeForIPC<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (err) {
    console.warn("[YAAIA] IPC serialization failed:", err);
    return String(value) as unknown as T;
  }
}

export type AiProvider = "claude" | "openrouter";

export interface McpConfig {
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
}

const DEFAULT_CONFIG: McpConfig = {
  aiProvider: "claude",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
};

function loadConfig(): McpConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.warn("[YAAIA] Config load failed:", err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: McpConfig): void {
  try {
    mkdirSync(APP_DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save config:", err);
  }
}

function getSystemChromePath(): string | null {
  const plat = platform();
  if (plat === "darwin") {
    const paths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/opt/homebrew/bin/chromium",
      "/opt/homebrew/bin/google-chrome-stable",
      "/usr/local/bin/chromium",
      "/usr/local/bin/google-chrome-stable",
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    for (const name of ["chromium", "google-chrome", "google-chrome-stable"]) {
      try {
        const p = execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8" }).trim();
        if (p && existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  } else if (plat === "win32") {
    const paths = [
      join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of paths) {
      if (p && existsSync(p)) return p;
    }
  } else {
    const paths = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      try {
        const p = execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8" }).trim();
        if (p && existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function getPlaceholderPath(): string {
  const resourcesDir = app.isPackaged
    ? join(__dirname, "..", "resources")
    : join(__dirname, "..", "..", "resources");
  return join(resourcesDir, "agent-browser-placeholder.html");
}

let mainWindow: BrowserWindow | null = null;
let agentBrowserProcess: ReturnType<typeof spawn> | null = null;
let mcpHttpServer: Server | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../../dist/index.html"));
  }

  mainWindow.on("ready-to-show", () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function pollCdpUntilReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${AGENT_BROWSER_DEBUG_PORT}/json`;
    let attempts = 0;
    const maxAttempts = 60;

    const tryFetch = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = (await res.json()) as unknown[];
          if (Array.isArray(data) && data.length > 0) {
            resolve();
            return;
          }
        }
      } catch {
        /* ignore */
      }
      attempts++;
      if (attempts >= maxAttempts) {
        reject(new Error("Agent browser did not become ready in time"));
        return;
      }
      setTimeout(tryFetch, 500);
    };

    tryFetch();
  });
}

async function grantClipboardPermission(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${AGENT_BROWSER_DEBUG_PORT}/json/version`);
    if (!res.ok) return;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    const wsUrl = data.webSocketDebuggerUrl;
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const id = 1;
    ws.send(
      JSON.stringify({
        id,
        method: "Browser.grantPermissions",
        params: { permissions: ["clipboardReadWrite"] },
      })
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", onMessage);
        ws.off("error", onError);
        resolve(); // proceed even if no response (permission may still apply)
      }, 3000);
      const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const msg = JSON.parse(String(raw)) as { id?: number };
          if (msg.id === id) {
            clearTimeout(timeout);
            ws.off("message", onMessage);
            ws.off("error", onError);
            resolve();
          }
        } catch {
          /* ignore */
        }
      };
      const onError = () => {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        ws.off("error", onError);
        reject(new Error("CDP error"));
      };
      ws.on("message", onMessage);
      ws.on("error", onError);
    });

    ws.close();
    console.log("[YAAIA] Clipboard permission granted for agent browser");
  } catch (err) {
    console.warn("[YAAIA] Could not grant clipboard permission:", err instanceof Error ? err.message : err);
  }
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return v === "1" || v.toLowerCase() === "true" || v === "yes";
}

async function ensureNoRestoreTabs(): Promise<void> {
  if (!parseBoolEnv("YAAIA_NO_RESTORE_TABS", true)) return;
  const defaultDir = join(AGENT_DATA_DIR, "Default");
  mkdirSync(defaultDir, { recursive: true });
  const prefsPath = join(defaultDir, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const raw = await readFile(prefsPath, "utf-8");
    prefs = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* file missing or invalid, use empty */
  }
  const session = (prefs.session as Record<string, unknown>) ?? {};
  session.restore_on_startup = 5; // 5 = New Tab Page (don't restore)
  prefs.session = session;
  const profile = (prefs.profile as Record<string, unknown>) ?? {};
  profile.name = "Agent Browser";
  profile.exit_type = "Normal";
  profile.exited_cleanly = true;
  prefs.profile = profile;
  await writeFile(prefsPath, JSON.stringify(prefs), "utf-8");
}

function spawnAgentBrowser(): void {
  mkdirSync(AGENT_DATA_DIR, { recursive: true });
  const chromePath = getSystemChromePath();
  if (!chromePath) {
    const msg =
      platform() === "darwin"
        ? "Google Chrome or Chromium not found. Install from https://www.google.com/chrome/ or run: brew install chromium"
        : platform() === "win32"
          ? "Google Chrome not found. Install from https://www.google.com/chrome/"
          : "Google Chrome or Chromium not found. Install with: sudo apt install chromium-browser (or google-chrome)";
    console.error("[YAAIA]", msg);
    mainWindow?.webContents?.send("agent-browser-error", msg);
    return;
  }
  const placeholderPath = getPlaceholderPath();
  const placeholderUrl = pathToFileURL(placeholderPath).href;
  const args = [
    `--user-data-dir=${AGENT_DATA_DIR}`,
    `--remote-debugging-port=${AGENT_BROWSER_DEBUG_PORT}`,
    "--start-maximized",
    "--password-store=basic",
    "--disable-save-password-bubble",
    "--disable-features=PasswordManager,PasswordLeakDetection",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    placeholderUrl,
  ];
  agentBrowserProcess = spawn(chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  agentBrowserProcess.stderr?.on("data", (chunk) => {
    const s = String(chunk).trim();
    if (s) console.warn("[YAAIA Chromium]", s);
  });

  agentBrowserProcess.on("error", (err) => {
    console.error("[YAAIA] Agent browser spawn error:", err);
    mainWindow?.webContents?.send("agent-browser-error", err.message);
  });

  agentBrowserProcess.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn("[YAAIA] Agent browser exited:", code, signal);
      mainWindow?.webContents?.send("agent-browser-error", `Agent browser exited (code ${code}). Restart the app.`);
    }
    agentBrowserProcess = null;
  });
}

function stopMcpServer(): void {
  if (mcpHttpServer) {
    mcpHttpServer.close();
    mcpHttpServer = null;
  }
  stopAgent();
}

app.setPath("userData", APP_DATA_DIR);

app.whenReady().then(async () => {
  createMainWindow();

  mainWindow?.webContents?.send("startup-progress", "Starting agent browser...");
  await ensureNoRestoreTabs();
  await new Promise((r) => setTimeout(r, 200));
  spawnAgentBrowser();

  try {
    await pollCdpUntilReady();
    mainWindow?.webContents?.send("startup-progress", "Agent browser ready");
    await new Promise((r) => setTimeout(r, 1500));
    await grantClipboardPermission();
    console.log("[YAAIA] Agent browser ready");
    setTimeout(() => refocusMainWindow(), 3000);
  } catch (err) {
    console.error("[YAAIA] Agent browser not ready:", err);
    mainWindow?.webContents?.send("agent-browser-error", err instanceof Error ? err.message : String(err));
  }
});

let isQuitting = false;
app.on("before-quit", async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  stopMcpServer();
  await stopChromeMcp();
  await stopKbMcp();
  await stopMailClient();
  if (agentBrowserProcess) {
    try {
      agentBrowserProcess.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    agentBrowserProcess = null;
  }
  if (recipeServer) {
    recipeServer.close();
    recipeServer = null;
  }

  isQuitting = false;
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (!isQuitting) app.quit();
});

ipcMain.handle("start-chat", async (_event, config: McpConfig) => {
  stopMcpServer();
  stopAgent();
  saveConfig(config);

  try {
    const hasApiKey =
      (config.aiProvider === "claude" && config.claudeApiKey?.trim()) ||
      (config.aiProvider === "openrouter" && config.openrouterApiKey?.trim());

    if (!hasApiKey) {
      return safeForIPC({
        ok: false,
        message: "Add API key for Claude or OpenRouter first.",
      });
    }

    recipeStore.clearPendingFinalize();
    mainWindow?.webContents?.send("startup-progress-reset");
    mainWindow?.webContents?.send("startup-progress", "Starting MCP server...");
    mcpHttpServer = await startMcpServer({
      onAskUserRequest: (info) => {
        refocusMainWindow();
        mainWindow?.webContents?.send("ask-user-popup", info);
      },
      onAskUserTimeout: () => {
        mainWindow?.webContents?.send("ask-user-popup-close");
      },
      onStartTask: (info) => {
        mainWindow?.webContents?.send("task-start", info);
      },
      onRefocusMainWindow: refocusMainWindow,
      onStartupProgress: (step) => mainWindow?.webContents?.send("startup-progress", step),
    });

    const mcpPort = getMcpServerPort(mcpHttpServer);
    mainWindow?.webContents?.send("startup-progress", "Starting agent...");
    const modelName =
      config.aiProvider === "claude" ? config.claudeModel : config.openrouterModel;
    recipeStore.setModel(modelName);

    await startAgent({
      mcpPort,
      aiProvider: config.aiProvider,
      claudeApiKey: config.claudeApiKey,
      claudeModel: config.claudeModel,
      openrouterApiKey: config.openrouterApiKey,
      openrouterModel: config.openrouterModel,
    });
    mainWindow?.webContents?.send("startup-progress", "Agent ready");

    recipeStore.setSessionTag(randomBytes(16).toString("hex"));

    return safeForIPC({
      ok: true,
      agentReady: true,
      message: "Agent is ready — ask what you'd like to do.",
    });
  } catch (err) {
    console.error("[YAAIA] Start chat failed:", err);
    return safeForIPC({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

ipcMain.handle("stop-chat", async () => {
  stopMcpServer();
  await stopChromeMcp();
  await stopKbMcp();
  await stopMailClient();
  recipeStore.clearSessionTag();
  return safeForIPC({ ok: true });
});

ipcMain.handle("agent-send-message", async (event, message: string, history: { role: "user" | "assistant"; content: string }[] = []) => {
  recipeStore.setInitialPrompt(message);
  try {
    const result = await sendMessage(
      message,
      (chunk) => event.sender.send("agent-stream-chunk", String(chunk ?? "")),
      history ?? []
    );
    const finalizeInfo = recipeStore.completeFinalizeWithReport(result.text ?? "");
    if (finalizeInfo) {
      refocusMainWindow();
      mainWindow?.webContents?.send("finalize-task-popup", finalizeInfo);
    }
    return safeForIPC(String(result.text ?? ""));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
});

ipcMain.handle("agent-abort", () => {
  requestAgentAbort();
  return undefined;
});

ipcMain.handle("ask-user-reply", (_, reply: string) => {
  deliverUserReply(reply);
  return undefined;
});

ipcMain.handle("ask-user-cancel", () => {
  deliverUserReply("User refused to reply.");
  return undefined;
});

ipcMain.handle("finalize-task-reply", (_, isSuccess: boolean) => {
  mainWindow?.webContents?.send("finalize-task-reply", isSuccess);
  return undefined;
});

ipcMain.handle("get-config", () => safeForIPC(loadConfig()));

ipcMain.handle("open-external", async (_event, url: string) => {
  if (typeof url === "string" && /^(https?|mailto):/i.test(url)) {
    await shell.openExternal(url);
  }
});

ipcMain.handle("secrets-list-full", () => safeForIPC(secretsListFull()));
ipcMain.handle(
  "secrets-set",
  (
    _,
    args: {
      detailed_description: string;
      first_factor: string;
      first_factor_type: string;
      value: string;
      totp_secret?: string;
      force?: boolean;
    }
  ) => {
    try {
      validateSecretsDesc(args.detailed_description);
      return secretsSet(
        args.detailed_description,
        args.first_factor,
        args.first_factor_type,
        args.value,
        args.force ?? false,
        args.totp_secret
      );
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);
ipcMain.handle("secrets-delete", (_, id: string) => {
  secretsDelete(id);
  return undefined;
});
ipcMain.handle("wipe-secrets", () => {
  secretsWipe();
  return undefined;
});

ipcMain.handle("agent-config-list", () => safeForIPC(agentConfigList()));
ipcMain.handle(
  "agent-config-set",
  (
    _,
    args: {
      detailed_description: string;
      value: string;
      force?: boolean;
    }
  ) => {
    try {
      validateConfigDesc(args.detailed_description);
      return agentConfigSet(args.detailed_description, args.value, args.force ?? false);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);
ipcMain.handle("agent-config-delete", (_, id: string) => {
  agentConfigDelete(id);
  return undefined;
});
ipcMain.handle("wipe-configs", () => {
  agentConfigWipe();
  return undefined;
});

ipcMain.handle("kb-list", (_, path: string, recursive: boolean) =>
  safeForIPC(kbList(path ?? ".", recursive ?? true))
);
ipcMain.handle("kb-read", (_, path: string) => {
  try {
    return kbRead(path);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
});
ipcMain.handle("kb-write", async (_, path: string, content: string) => {
  try {
    kbWrite(path, content);
    await runQmdCli(["update"]);
    await runQmdCli(["embed"]);
    return undefined;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
});
ipcMain.handle("kb-delete", async (_, path: string) => {
  try {
    kbDelete(path);
    await runQmdCli(["update"]);
    await runQmdCli(["embed"]);
    return undefined;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
});

const RECIPE_PORT = 17892;
let recipeServer: ReturnType<typeof createServer> | null = null;

function ensureRecipeServer(): void {
  if (recipeServer) return;
  recipeServer = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const entryMatch = url.match(/^\/entry-(\d+)\.png$/);
    if (entryMatch) {
      const idx = parseInt(entryMatch[1], 10) - 1;
      const r = recipeStore.getRecipe();
      const entry = r?.entries[idx];
      const base64 = entry?.screenshotBase64 ?? entry?.terminalBase64;
      if (base64) {
        const buf = Buffer.from(base64, "base64");
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (url === "/marked.js") {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const markedPath = dirname(require.resolve("marked/package.json")) + "/lib/marked.umd.js";
      const buf = readFileSync(markedPath);
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(buf);
      return;
    }
    if (url === "/RECIPE.md") {
      const md = recipeStore.generateMarkdown();
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(md);
      return;
    }
    if (url === "/" || url === "/index.html") {
      const md = recipeStore.generateMarkdown();
      const html = recipeStore.generateRecipeIndexHtml(md);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  recipeServer.listen(RECIPE_PORT, "127.0.0.1");
}

ipcMain.handle("recipe-view", async () => {
  ensureRecipeServer();
  shell.openExternal(`http://127.0.0.1:${RECIPE_PORT}/`);
  return undefined;
});

ipcMain.handle("recipe-save", async () => {
  ensureRecipeServer();
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Save recipe",
    defaultPath: `recipe-${Date.now()}.zip`,
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  });
  if (result.canceled) return null;
  await recipeStore.saveRecipeToZip(result.filePath!);
  return result.filePath ?? null;
});

ipcMain.handle("recipe-load", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Load recipe",
    properties: ["openFile"],
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, error: "Cancelled" };
  const { loadRecipeFromZip } = await import("./recipe-load.js");
  return loadRecipeFromZip(result.filePaths[0]);
});

ipcMain.handle("agent-inject-message", (_, msg: string, placeAfterAskUser?: boolean) => {
  recipeStore.appendUserInjection(msg, placeAfterAskUser ?? false);
  setPendingInjectMessage(msg);
  return undefined;
});

ipcMain.handle("recipe-set-initial-prompt", (_, message: string) => {
  recipeStore.setInitialPrompt(message);
  return undefined;
});
