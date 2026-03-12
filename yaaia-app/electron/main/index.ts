import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from "electron";
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
import { startMcpServer, getMcpServerPort, stopChromeMcp, stopKbMcp, stopMailClient, stopCaldavClient } from "./mcp-server/index.js";
import {
  telegramConnect,
  telegramDisconnect,
  setOnTelegramMessage,
  telegramSendText,
  telegramSendTyping,
  telegramResolvePeer,
  telegramFetchMissedMessages,
  isTelegramConnected,
} from "./telegram-client.js";
import { setOnMailMessage } from "./mail-client.js";
import {
  setOnCaldavEvent,
  setOnCaldavEventDeleted,
  caldavConnect,
  caldavDisconnect,
  caldavInitAndWatch,
  caldavListCalendars,
  caldavListEvents,
  caldavGetEvent,
  caldavCreateEvent,
  caldavUpdateEvent,
  caldavDeleteEvent,
  isCaldavConnected,
} from "./caldav-client.js";
import {
  startAgent,
  stopAgent,
  sendMessage,
  requestAgentAbort,
  setPendingInjectMessage,
  setOnAssessmentClarification,
  addToAgentInjectedQueue,
  setAgentRunActive,
  clearAgentInjectedQueue,
  isAgentRunActive,
} from "./ai-agent/index.js";
import { deliverUserReply, isWaitingForAskUser, getWaitingAskUserBusId } from "./ask-user-bridge.js";
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
import {
  listSchedules,
  addSchedule,
  updateSchedule,
  deleteSchedule,
  getDueSchedules,
  deleteSchedules,
  getStartupTask,
  setStartupTask,
} from "./schedule-store.js";
import {
  appendToBusHistory,
  ensureBus,
  getBusHistory,
  getBusHistorySlice,
  getRootBusHistoryOnly,
  getRootLogForModel,
  isBusBanned,
  listBuses,
  setBusProperties,
  getBusTrustLevel,
  deleteBus,
  wipeRootHistory,
  ROOT_BUS_ID,
} from "./message-bus-store.js";
import { hasTaskForEventUid, setEventTaskMapping, removeEventTaskMapping } from "./caldav-event-tasks-store.js";
import { hasEventInBusHistory, removeMessagesFromBusHistoryByEventUids } from "./history-store.js";
import { ensureHistoryCollection } from "./history-store.js";

// Enable tsdav debug logs in console (CalDAV requests, homeUrl, etc.)
if (!process.env.DEBUG?.includes("tsdav")) {
  process.env.DEBUG = process.env.DEBUG ? `${process.env.DEBUG},tsdav:*` : "tsdav:*";
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const YAAIA_DIR = join(homedir(), "yaaia");
const APP_DATA_DIR = join(YAAIA_DIR, "appData");
const AGENT_DATA_DIR = join(YAAIA_DIR, "agentData");
const CONFIG_PATH = join(APP_DATA_DIR, "config.json");

const AGENT_BROWSER_DEBUG_PORT = 9222;

const _k = "y4a1a";
const _x = (h: string) => Buffer.from(h, "hex").map((b: number, i: number) => b ^ _k.charCodeAt(i % _k.length)).toString();
const TELEGRAM_APP_ID = 2097227698 ^ 0x7F3C1A2B;
const TELEGRAM_APP_HASH = _x("1b5556540441515109521f005100034e0d5006574d0d03500418055407511c00");
const CALDAV_GOOGLE_CLIENT_ID = _x("4b0c5009504f005308564b054c501214555556054a5e0a0217185653020d1304575d0441415440090c0d054058575511411257530e5e0615511442040b570e5f151c5a151f021659");
const CALDAV_GOOGLE_CLIENT_SECRET = _x("3e7b22623121190d421418732c7231400d595c0330781046582b640a49353d66237f54");

/** Buses we've delivered to the agent since root was wiped. Cleared on wipe. */
const busesDeliveredSinceRootWipe = new Set<string>();

/** Track if agent sent to target bus during current run (for Telegram fallback). */
let sentToTargetBusDuringRun = false;
let currentTargetBusIdForRun: string | null = null;

let scheduleIntervalHandle: ReturnType<typeof setInterval> | null = null;

function buildScheduleMessage(schedules: { at: string; title: string; instructions: string }[]): string {
  const now = new Date().toISOString();
  if (schedules.length === 1) {
    const s = schedules[0];
    return `[Scheduled task]\n\nCurrent time: ${now}\nScheduled for: ${s.at}\n\nTitle: ${s.title}\nInstructions: ${s.instructions}`;
  }
  const lines: string[] = [
    "[Scheduled tasks — missed while app was closed]",
    "",
    `Current time: ${now}`,
    "",
  ];
  schedules.forEach((s, i) => {
    lines.push(`--- Task ${i + 1} ---`, `Scheduled for: ${s.at}`, `Title: ${s.title}`, `Instructions: ${s.instructions}`, "");
  });
  return lines.join("\n").trimEnd();
}

function runStartupTask(): void {
  const task = getStartupTask();
  const due = getDueSchedules();
  let content = `[Startup task]\n\nTitle: ${task.title}\nInstructions: ${task.instructions}`;
  if (due.length > 0) {
    const ids = due.map((s) => s.id);
    deleteSchedules(ids);
    content += `\n\n--- Resume: complete these scheduled tasks (were due while app was closed) ---\n\n${buildScheduleMessage(due)}`;
  }
  const msg = JSON.stringify({
    bus_id: ROOT_BUS_ID,
    user_id: 0,
    user_name: "System",
    content,
  });
  const injectHandled = isAgentRunActive();
  if (injectHandled) addToAgentInjectedQueue(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("schedule-trigger", { msg, injectHandled });
  }
}

function runDueSchedules(): void {
  const due = getDueSchedules();
  if (due.length === 0) return;
  const ids = due.map((s) => s.id);
  deleteSchedules(ids);
  const content = buildScheduleMessage(due);
  const msg = JSON.stringify({
    bus_id: ROOT_BUS_ID,
    user_id: 0,
    user_name: "Scheduled",
    content,
  });
  const injectHandled = isAgentRunActive();
  if (injectHandled) addToAgentInjectedQueue(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("schedule-trigger", { msg, injectHandled });
  }
}

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
  userName: string;
}

const DEFAULT_CONFIG: McpConfig = {
  aiProvider: "claude",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  userName: "",
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

function getResourcesDir(): string {
  return app.isPackaged ? join(__dirname, "..", "resources") : join(__dirname, "..", "..", "resources");
}

function getPlaceholderPath(): string {
  return join(getResourcesDir(), "agent-browser-placeholder.html");
}

function getIconPath(): string {
  return join(getResourcesDir(), "icon.png");
}

let mainWindow: BrowserWindow | null = null;
let agentBrowserProcess: ReturnType<typeof spawn> | null = null;
let mcpHttpServer: Server | null = null;

function createMainWindow(): void {
  const iconPath = getIconPath();
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    ...(existsSync(iconPath) && { icon: nativeImage.createFromPath(iconPath) }),
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
  await stopCaldavClient();
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
    setOnTelegramMessage((payload, opts) => {
      try {
        if (isWaitingForAskUser() && getWaitingAskUserBusId() === payload.bus_id) {
          deliverUserReply(payload.content, payload.bus_id);
          return;
        }
        if (isBusBanned(payload.bus_id)) {
          const peerId = parseInt(payload.bus_id.replace("telegram-", ""), 10);
          if (!isNaN(peerId)) telegramSendText(peerId, "I don't want to talk with you").catch(() => {});
          return;
        }
        ensureBus(payload.bus_id, `Telegram: ${payload.user_name}`);
        const busMsg = {
          role: "user" as const,
          content: payload.content,
          user_id: payload.user_id,
          user_name: payload.user_name,
          bus_id: payload.bus_id,
          timestamp: payload.timestamp,
        };
        appendToBusHistory(payload.bus_id, busMsg);
        const peerId = parseInt(payload.bus_id.replace("telegram-", ""), 10);
        if (!isNaN(peerId) && isTelegramConnected()) {
          telegramSendTyping(peerId).catch(() => { });
        }
        const isFirstFromBus = !busesDeliveredSinceRootWipe.has(payload.bus_id);
        if (isFirstFromBus) busesDeliveredSinceRootWipe.add(payload.bus_id);
        const busContext =
          isFirstFromBus
            ? (() => {
                const last10 = getBusHistorySlice(payload.bus_id, 10, 0);
                const ctx = last10.length
                  ? `Recent history for ${payload.bus_id}:\n${last10.map((m) => `${m.role}: ${m.content}`).join("\n")}`
                  : "";
                return ctx ? `${ctx}\n\n` : "";
              })()
            : "";
        const instruction = `${busContext}If you need more context for this bus, call get_bus_history(bus_id="${payload.bus_id}", assessment="...", clarification="...", limit=50, offset=0) for last 50, or use negative offset for earlier messages.`;
        const injectHandled = isAgentRunActive();
        if (injectHandled) addToAgentInjectedQueue(JSON.stringify(payload));
        if (opts?.deliverToModel !== false && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("telegram-message", { ...payload, instruction, injectHandled });
        }
      } catch (err) {
        console.error("[YAAIA] Telegram callback error:", err);
      }
    });
    setOnMailMessage((payload, opts) => {
      try {
        if (isBusBanned(payload.bus_id)) return;
        ensureBus(payload.bus_id, `Email: ${payload.user_name}`);
        const busMsg = {
          role: "user" as const,
          content: payload.content,
          user_id: payload.user_id,
          user_name: payload.user_name,
          bus_id: payload.bus_id,
          timestamp: payload.timestamp,
          mail_uid: payload.mail_uid,
        };
        appendToBusHistory(payload.bus_id, busMsg);
        const injectHandled = isAgentRunActive();
        if (injectHandled) addToAgentInjectedQueue(JSON.stringify(payload));
        if (opts?.deliverToModel && mainWindow && !mainWindow.isDestroyed()) {
          const isFirstFromBus = !busesDeliveredSinceRootWipe.has(payload.bus_id);
          if (isFirstFromBus) busesDeliveredSinceRootWipe.add(payload.bus_id);
          const busContext =
            isFirstFromBus
              ? (() => {
                  const last10 = getBusHistorySlice(payload.bus_id, 10, 0);
                  return last10.length
                    ? `Recent history for ${payload.bus_id}:\n${last10.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\n`
                    : "";
                })()
              : "";
          const instruction = `${busContext}If you need more context for this bus, call get_bus_history(bus_id="${payload.bus_id}", assessment="...", clarification="...", limit=50, offset=0).`;
          mainWindow.webContents.send("email-message", { ...payload, instruction, injectHandled });
        }
      } catch (err) {
        console.error("[YAAIA] Mail callback error:", err);
      }
    });
    setOnCaldavEvent((payload, opts) => {
      try {
        if (isBusBanned(payload.bus_id)) return;
        ensureBus(payload.bus_id, `Calendar: ${payload.calendar_display_name}`);
        if (hasEventInBusHistory(payload.bus_id, payload.event_uid)) return;
        const content =
          `[Calendar event ${payload.is_new ? "created" : "updated"}]\n\n` +
          `Summary: ${payload.summary}\n` +
          `Start: ${payload.start}\n` +
          `End: ${payload.end}\n` +
          (payload.location ? `Location: ${payload.location}\n` : "") +
          (payload.description ? `Description: ${payload.description}\n` : "") +
          `\nEvent UID: ${payload.event_uid}`;
        const busMsg = {
          role: "user" as const,
          content,
          user_id: 0,
          user_name: "Calendar",
          bus_id: payload.bus_id,
          timestamp: new Date().toISOString(),
          event_uid: payload.event_uid,
        };
        appendToBusHistory(payload.bus_id, busMsg);

        const eventStart = new Date(payload.start);
        if (eventStart.getTime() > Date.now() && !hasTaskForEventUid(payload.event_uid)) {
          const instructions =
            `Calendar event happened, notify participants if required. ` +
            `Summary: ${payload.summary}. Start: ${payload.start}. End: ${payload.end}. ` +
            (payload.location ? `Location: ${payload.location}. ` : "") +
            (payload.description ? `Description: ${payload.description}.` : "");
          const entry = addSchedule(payload.start, payload.summary, instructions);
          setEventTaskMapping(payload.event_uid, entry.id);
        }

        const injectHandled = isAgentRunActive();
        if (injectHandled) addToAgentInjectedQueue(JSON.stringify({ ...payload, content }));
        if (opts?.deliverToModel && mainWindow && !mainWindow.isDestroyed()) {
          const isFirstFromBus = !busesDeliveredSinceRootWipe.has(payload.bus_id);
          if (isFirstFromBus) busesDeliveredSinceRootWipe.add(payload.bus_id);
          const busContext = isFirstFromBus
            ? (() => {
                const last10 = getBusHistorySlice(payload.bus_id, 10, 0);
                return last10.length
                  ? `Recent history for ${payload.bus_id}:\n${last10.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\n`
                  : "";
              })()
            : "";
          const instruction = `${busContext}If you need more context for this bus, call get_bus_history(bus_id="${payload.bus_id}", assessment="...", clarification="...", limit=50, offset=0).`;
          mainWindow.webContents.send("caldav-event", { ...payload, content, instruction, injectHandled });
        }
      } catch (err) {
        console.error("[YAAIA] CalDAV callback error:", err);
      }
    });
    setOnCaldavEventDeleted((eventUid, busId) => {
      removeEventTaskMapping(eventUid);
      removeMessagesFromBusHistoryByEventUids(busId, [eventUid]);
      mainWindow?.webContents?.send("caldav-event-deleted", { eventUid, busId });
    });
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
      onSendMessageToRoot: (content) => mainWindow?.webContents?.send("agent-message", content),
      onSendMessage: (busId) => {
        if (currentTargetBusIdForRun && busId === currentTargetBusIdForRun) sentToTargetBusDuringRun = true;
      },
      onSendMessageToTelegram: async (busId, content) => {
        const peerId = parseInt(busId.replace("telegram-", ""), 10);
        if (!isNaN(peerId)) await telegramSendText(peerId, content);
      },
      onOpenExternal: async (url) => {
        await shell.openExternal(url);
      },
      onCaldavEventDeleted: (eventUid, busId) => {
        mainWindow?.webContents?.send("caldav-event-deleted", { eventUid, busId });
      },
      onTelegramSearch: async (username) => {
        if (!isTelegramConnected()) {
          throw new Error("Telegram not connected. Call telegram_connect first.");
        }
        return telegramResolvePeer(username);
      },
      onTelegramConnect: async (phone) => {
        if (isTelegramConnected()) {
          const buses = listBuses().filter((b) => b.bus_id.startsWith("telegram-"));
          const instruction =
            "If you need more context for a bus, call get_bus_history(bus_id, assessment, clarification, limit, offset). offset=0 = last N; offset<0 = from end.";
          const missed = await telegramFetchMissedMessages({ deliverToModel: false });
          return { ok: true, buses, instruction, missedMessages: missed };
        }
        try {
          await telegramConnect({
            apiId: TELEGRAM_APP_ID,
            apiHash: TELEGRAM_APP_HASH,
            phone: phone.trim(),
            getLoginInput: async (step) => {
              return new Promise<string>((resolve) => {
                pendingTelegramLoginResolve = resolve;
                mainWindow?.webContents?.send("telegram-login-request", { step });
              });
            },
          });
          const buses = listBuses().filter((b) => b.bus_id.startsWith("telegram-"));
          const instruction =
            "If you need more context for a bus, call get_bus_history(bus_id, assessment, clarification, limit, offset). offset=0 = last N; offset<0 = from end.";
          const missed = await telegramFetchMissedMessages({ deliverToModel: false });
          return {
            ok: true,
            buses,
            instruction,
            missedMessages: missed,
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      appConfig: {
        userName: config.userName ?? "",
        caldavGoogleClientId: CALDAV_GOOGLE_CLIENT_ID,
        caldavGoogleClientSecret: CALDAV_GOOGLE_CLIENT_SECRET,
      },
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
    setOnAssessmentClarification((busId, assessment, clarification) => {
      if (recipeStore.getTaskBusId() !== busId) return;
      if (getBusTrustLevel(busId) !== "root") return;
      if (!busId.startsWith("telegram-")) return;
      const parts: string[] = [];
      if (assessment) parts.push(`**Assessment:** ${assessment}`);
      if (clarification) parts.push(`**Clarification:** ${clarification}`);
      if (parts.length === 0) return;
      const peerId = parseInt(busId.replace("telegram-", ""), 10);
      if (!isNaN(peerId)) telegramSendText(peerId, parts.join("\n\n")).catch((err) => console.warn("[YAAIA] Forward assessment/clarification failed:", err));
    });
    mainWindow?.webContents?.send("startup-progress", "Agent ready");

    recipeStore.setSessionTag(randomBytes(16).toString("hex"));

    runStartupTask();
    runDueSchedules();
    if (scheduleIntervalHandle) clearInterval(scheduleIntervalHandle);
    scheduleIntervalHandle = setInterval(runDueSchedules, 60_000);

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
  if (scheduleIntervalHandle) {
    clearInterval(scheduleIntervalHandle);
    scheduleIntervalHandle = null;
  }
  stopMcpServer();
  await stopChromeMcp();
  await stopKbMcp();
  await stopMailClient();
  await stopCaldavClient();
  await telegramDisconnect();
  setOnTelegramMessage(null);
  setOnMailMessage(null);
  setOnAssessmentClarification(null);
  recipeStore.clearSessionTag();
  clearAgentInjectedQueue();
  busesDeliveredSinceRootWipe.clear();
  return safeForIPC({ ok: true });
});

ipcMain.handle(
  "agent-send-message",
  async (
    event,
    message: string,
    _history: { role: "user" | "assistant"; content: string }[] = [],
    busId?: string
  ) => {
    setAgentRunActive(true);
    try {
      return await handleAgentSendMessage(event, message, busId);
    } finally {
      setAgentRunActive(false);
    }
  }
);

async function handleAgentSendMessage(
  event: Electron.IpcMainInvokeEvent,
  message: string,
  busId?: string
): Promise<string> {
  const cfg = loadConfig();
    let targetBusId = busId ?? ROOT_BUS_ID;
    let userMsg: string;

    if (typeof message === "string" && message.startsWith("[QUEUED]\n")) {
      targetBusId = ROOT_BUS_ID;
      const lines = message.slice(9).split("\n").filter((l) => l.trim());
      const parts: string[] = [];
      const readableLines: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            content?: string;
            user_id?: number;
            user_name?: string;
            bus_id?: string;
            timestamp?: string;
            mail_uid?: number;
            event_uid?: string;
          };
          const busIdForAppend = parsed.bus_id && parsed.bus_id !== ROOT_BUS_ID ? parsed.bus_id : ROOT_BUS_ID;
          const content = parsed.content ?? line;
          const busMsg = {
            role: "user" as const,
            content,
            user_id: parsed.user_id ?? 0,
            user_name: parsed.user_name ?? cfg.userName ?? "",
            bus_id: busIdForAppend,
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            ...(parsed.mail_uid !== undefined && { mail_uid: parsed.mail_uid }),
            ...(parsed.event_uid && { event_uid: parsed.event_uid }),
          };
          /* Append all queued messages to their buses so they appear in get_bus_history tool results.
           * For non-root: avoid duplicate if last message in bus already matches (delivery callback may have appended). */
          if (busIdForAppend === ROOT_BUS_ID) {
            appendToBusHistory(ROOT_BUS_ID, { ...busMsg, bus_id: ROOT_BUS_ID });
          } else {
            ensureBus(
              busIdForAppend,
              busIdForAppend.startsWith("telegram-")
                ? `Telegram: ${parsed.user_name ?? ""}`
                : busIdForAppend.startsWith("email-")
                  ? `Email: ${parsed.user_name ?? ""}`
                  : busIdForAppend.startsWith("caldav-")
                    ? `Calendar: ${busIdForAppend}`
                    : busIdForAppend
            );
            const last = getBusHistorySlice(busIdForAppend, 1, 0)[0];
            const alreadyAppended = last?.role === "user" && last?.content === content;
            if (!alreadyAppended) {
              appendToBusHistory(busIdForAppend, busMsg);
            }
          }
          parts.push(line);
          const label =
            busIdForAppend.startsWith("telegram-")
              ? `Telegram (${parsed.user_name ?? ""})`
              : busIdForAppend.startsWith("email-")
                ? `Email (${parsed.user_name ?? ""})`
                : busIdForAppend.startsWith("caldav-")
                  ? `Calendar (${busIdForAppend})`
                  : "Desktop";
          readableLines.push(`[${label}]: ${content}`);
        } catch {
          /* skip malformed line */
        }
      }
      userMsg =
        readableLines.length > 0
          ? `New messages received while you were busy:\n\n${readableLines.join("\n\n")}`
          : "[QUEUED]\n" + parts.join("\n");
    } else {
      if (targetBusId === ROOT_BUS_ID) {
        let parsed: { content?: string; user_id?: number; user_name?: string; bus_id?: string } | null = null;
        if (typeof message === "string" && message.startsWith("{")) {
          try {
            parsed = JSON.parse(message);
          } catch {
            /* fall through */
          }
        }
        const content = parsed?.content ?? message;
        const user_name = parsed?.user_name ?? cfg.userName ?? "";
        const user_id = parsed?.user_id ?? 0;
        const bus_id = parsed?.bus_id && parsed.bus_id !== ROOT_BUS_ID ? parsed.bus_id : undefined;
        appendToBusHistory(ROOT_BUS_ID, {
          role: "user",
          content,
          user_id,
          user_name,
          ...(bus_id && { bus_id }),
        });
      }
      userMsg =
        typeof message === "string" && message.startsWith("{")
          ? message
          : JSON.stringify({
            bus_id: ROOT_BUS_ID,
            user_id: 0,
            user_name: cfg.userName ?? "",
            content: message,
          });
    }
    const tag = recipeStore.getSessionTag();
    const { messages: busHistory, trimmedCount } = getRootLogForModel();
    const history: { role: "user" | "assistant"; content: string; wrap?: boolean }[] = busHistory.map((m) => {
      const busId = m.bus_id ?? ROOT_BUS_ID;
      const wrap = getBusTrustLevel(busId) === "root" && !!tag;
      if (m.role === "user") {
        return {
          role: "user" as const,
          content: JSON.stringify({
            bus_id: busId,
            user_id: m.user_id ?? 0,
            user_name: m.user_name ?? "",
            content: m.content,
          }),
          wrap,
        };
      }
      return { role: "assistant" as const, content: m.content, wrap };
    });
    recipeStore.setInitialPrompt(message);
    if (targetBusId !== ROOT_BUS_ID) {
      currentTargetBusIdForRun = targetBusId;
      sentToTargetBusDuringRun = false;
    } else {
      currentTargetBusIdForRun = null;
    }
    const doSend = async () =>
      sendMessage(
        userMsg,
        (chunk) => event.sender.send("agent-stream-chunk", String(chunk ?? "")),
        history,
        targetBusId,
        trimmedCount
      );

    let result: { text: string };
    try {
      result = await doSend();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Session not found") &&
        mcpHttpServer &&
        !mainWindow?.isDestroyed()
      ) {
        try {
          const cfg = loadConfig();
          const mcpPort = getMcpServerPort(mcpHttpServer);
          await startAgent({
            mcpPort,
            aiProvider: cfg.aiProvider ?? "claude",
            claudeApiKey: cfg.claudeApiKey ?? "",
            claudeModel: cfg.claudeModel ?? "claude-sonnet-4-6",
            openrouterApiKey: cfg.openrouterApiKey ?? "",
            openrouterModel: cfg.openrouterModel ?? "google/gemini-2.5-flash",
          });
          console.log("[YAAIA] Reconnected agent after session loss");
          result = await doSend();
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`Session lost. Please exit and restart the chat. (${retryMsg})`);
        }
      } else {
        throw new Error(msg);
      }
    }

    try {
      const finalizeInfo = recipeStore.completeFinalizeWithReport(result.text ?? "");
      if (finalizeInfo) {
        mainWindow?.webContents?.send("finalize-task-popup", finalizeInfo);
      }
      const fallbackText = result.text?.trim();
      if (targetBusId === ROOT_BUS_ID && fallbackText) {
        const rootOnly = getRootBusHistoryOnly();
        const lastAssistant = [...rootOnly].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.content !== fallbackText) {
          appendToBusHistory(ROOT_BUS_ID, { role: "assistant", content: fallbackText });
        }
      }
      if (
        targetBusId !== ROOT_BUS_ID &&
        !sentToTargetBusDuringRun &&
        fallbackText &&
        fallbackText !== "Done." &&
        fallbackText !== "Stopped by user."
      ) {
        const peerId = parseInt(targetBusId.replace("telegram-", ""), 10);
        if (!isNaN(peerId)) {
          try {
            await telegramSendText(peerId, fallbackText);
            appendToBusHistory(targetBusId, { role: "assistant", content: fallbackText });
          } catch (err) {
            console.warn("[YAAIA] Fallback send to Telegram failed:", err);
          }
        }
      }
      ensureHistoryCollection()
        .then(() => runQmdCli(["update"]))
        .then(() => runQmdCli(["embed"]))
        .catch((err) => console.warn("[YAAIA] History index update failed:", err));
      return safeForIPC(String(result.text ?? ""));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg);
    }
}

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

let pendingTelegramLoginResolve: ((value: string) => void) | null = null;
ipcMain.handle("telegram-login-reply", (_event, value: string) => {
  if (pendingTelegramLoginResolve) {
    pendingTelegramLoginResolve(String(value ?? "").trim());
    pendingTelegramLoginResolve = null;
  }
  return undefined;
});

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

ipcMain.handle("message-bus-list", () => safeForIPC(listBuses()));
ipcMain.handle("message-bus-set-description", (_, busId: string, description: string) => {
  setBusProperties(busId, { description });
  return undefined;
});
ipcMain.handle("message-bus-delete", async (_, busId: string) => {
  await deleteBus(busId);
  return undefined;
});
ipcMain.handle("message-bus-get-history", (_, busId: string) => safeForIPC(getBusHistory(busId)));
ipcMain.handle("message-bus-wipe-root", () => {
  wipeRootHistory();
  busesDeliveredSinceRootWipe.clear();
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

ipcMain.handle("schedule-list", () => safeForIPC(listSchedules()));
ipcMain.handle("schedule-get-startup", () => safeForIPC(getStartupTask()));
ipcMain.handle("schedule-set-startup", (_, task: { title: string; instructions: string }) => {
  setStartupTask(task);
  return undefined;
});
ipcMain.handle("schedule-add", (_, at: string, title: string, instructions: string) => {
  const entry = addSchedule(at, title, instructions);
  return safeForIPC(entry);
});
ipcMain.handle("schedule-update", (_, id: string, props: { at?: string; title?: string; instructions?: string }) => {
  const updated = updateSchedule(id, props);
  return safeForIPC(updated);
});
ipcMain.handle("schedule-delete", (_, id: string) => safeForIPC(deleteSchedule(id)));

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

ipcMain.handle("agent-queue-message", (_, msg: string) => {
  addToAgentInjectedQueue(msg);
  /* Append to history so message appears in refreshMessagesFromRoot and get_bus_history */
  let parsed: { content?: string; user_id?: number; user_name?: string; bus_id?: string } | null = null;
  if (typeof msg === "string" && msg.startsWith("{")) {
    try {
      parsed = JSON.parse(msg);
    } catch {
      /* ignore */
    }
  }
  const content = parsed?.content ?? msg;
  const user_name = parsed?.user_name ?? loadConfig().userName ?? "";
  const user_id = parsed?.user_id ?? 0;
  const bus_id = parsed?.bus_id && parsed.bus_id !== ROOT_BUS_ID ? parsed.bus_id : undefined;
  appendToBusHistory(ROOT_BUS_ID, {
    role: "user",
    content,
    user_id,
    user_name,
    ...(bus_id && { bus_id }),
  });
  return undefined;
});

ipcMain.handle("agent-inject-message", (_, msg: string, placeAfterAskUser?: boolean) => {
  recipeStore.appendUserInjection(msg, placeAfterAskUser ?? false);
  setPendingInjectMessage(msg);
  let parsed: { content?: string; user_id?: number; user_name?: string; bus_id?: string } | null = null;
  if (typeof msg === "string" && msg.startsWith("{")) {
    try {
      parsed = JSON.parse(msg);
    } catch {
      /* ignore */
    }
  }
  const busId = parsed?.bus_id;
  if (busId?.startsWith("telegram-")) {
    return undefined;
  }
  const content = parsed?.content ?? msg;
  const user_name = parsed?.user_name ?? loadConfig().userName ?? "";
  const user_id = parsed?.user_id ?? 0;
  appendToBusHistory(busId === "root" || !busId ? ROOT_BUS_ID : busId, {
    role: "user",
    content,
    user_id,
    user_name,
    ...(busId && busId !== "root" && { bus_id: busId }),
  });
  return undefined;
});

ipcMain.handle("recipe-set-initial-prompt", (_, message: string) => {
  recipeStore.setInitialPrompt(message);
  return undefined;
});
