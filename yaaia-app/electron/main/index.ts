import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from "electron";
import { exec } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { ensureStorageDirs, ensureVmAgentInShared, kbEnsureCollection } from "./mcp-server/kb-client.js";
import { mailDisconnect as stopMailClient } from "./mail-client.js";
import { setDirectToolsConfig } from "./direct-tools.js";
import {
  telegramConnect,
  telegramDisconnect,
  setOnTelegramMessage,
  telegramSendText,
  telegramSendTyping,
  telegramResolvePeer,
  telegramFetchMissedMessages,
  isTelegramConnected,
  saveTelegramConnectPhone,
  loadTelegramConnectPhone,
} from "./telegram-client.js";
import { setOnMailMessage, mailMessageFlagsAdd } from "./mail-client.js";
import {
  startAgent,
  stopAgent,
  sendMessage,
  clearAgentSessionApiMessages,
  requestAgentAbort,
  setPendingInjectMessage,
  setRouteCallbacksForEval,
  addToAgentInjectedQueue,
  getAndClearAgentInjectedQueue,
  hasAgentInjectedMessages,
  setAgentRunActive,
  clearAgentInjectedQueue,
  isAgentRunActive,
} from "./ai-agent/index.js";
import { setDeliveryCallbacks } from "./message-delivery.js";
import { deliverUserReply, isWaitingForAskUser, getWaitingAskUserBusId } from "./ask-user-bridge.js";
import {
  passwordsWipe,
  passwordsListFull,
  passwordsSet,
  passwordsDelete,
} from "./passwords-store.js";
import { stopOllama } from "./ollama-manager.js";
import * as recipeStore from "./recipe-store.js";
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
  getRootHistorySliceWithTotal,
  getRootLogForModel,
  isBusBanned,
  listBuses,
  setBusProperties,
  getBusTrustLevel,
  deleteBus,
  wipeRootHistory,
  wipeAllHistory,
  ROOT_BUS_ID,
  hasEventInBusHistory,
  hasMailUidInBusHistory,
  hasMessageIdInBusHistory,
  removeMessagesFromBusHistoryByEventUids,
  isValidBusIdFormat,
} from "./message-db.js";
import { hasTaskForEventUid, setEventTaskMapping, removeEventTaskMapping } from "./caldav-event-tasks-store.js";
import {
  resolveContact,
  contactList,
  contactGet,
  contactCreate,
  contactUpdate,
  contactDelete,
  contactSearch,
} from "./contacts-store.js";
import { shouldBanBusForNoIdentity, incrementIdentityAttempts } from "./identity-attempts-store.js";
import { ensureHistoryCollection } from "./message-db.js";
import {
  createAuthorizationFlow,
  exchangeAuthorizationCode,
  startCodexOAuthServer,
  loadCodexAuth,
  clearCodexAuth,
} from "./codex-auth.js";
import {
  startGoogleOAuthFlow,
  exchangeGoogleCode,
  isGoogleAuthorized,
  clearGoogleAuth,
} from "./google-auth.js";
import { initGoogleBuses } from "./google-buses.js";
import {
  startGooglePoll,
  stopGooglePoll,
  setOnGmailMessage,
  setOnCalendarEvent,
} from "./google-poll.js";
import {
  listVms,
  createVm,
  startVm,
  stopVm,
  deleteVm,
  showConsoleVm,
  getVmSerialPort,
  type CreateVmOptions,
} from "./vm-manager.js";
import { startYaaiaVm, stopYaaiaVm } from "./vm-launcher.js";
import { getVmSerialPortFromFile } from "./vm-ports.js";
import { startVmEvalServer, stopVmEvalServer, setOnVmConnected } from "./vm-eval-server.js";
import { clearEvalContext } from "./agent-eval.js";

// Suppress unhandled MCP "Connection closed" rejections (expected when subprocesses exit on shutdown)
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("Connection closed") || (reason as { code?: number })?.code === -32000) {
    console.warn("[YAAIA] MCP connection closed (expected on shutdown):", msg);
    return;
  }
});

// Enable verbose agent/API logs (OpenRouter, Claude, Codex, eval, tool calls)
if (!process.env.DEBUG?.includes("yaaia")) {
  process.env.DEBUG = process.env.DEBUG ? `${process.env.DEBUG},yaaia:*` : "yaaia:*";
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const YAAIA_DIR = join(homedir(), "yaaia");
const YAAIA_SHARED_DIR = join(YAAIA_DIR, "storage", "shared");
const APP_DATA_DIR = join(YAAIA_DIR, "appData");
const CONFIG_PATH = join(APP_DATA_DIR, "config.json");

const _k = "y4a1a";
const _x = (h: string) => Buffer.from(h, "hex").map((b: number, i: number) => b ^ _k.charCodeAt(i % _k.length)).toString();
const TELEGRAM_APP_ID = 2097227698 ^ 0x7F3C1A2B;
const TELEGRAM_APP_HASH = _x("1b5556540441515109521f005100034e0d5006574d0d03500418055407511c00");

/** Buses we've delivered to the agent since root was wiped. Cleared on wipe. */
const busesDeliveredSinceRootWipe = new Set<string>();

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

function queueAndTriggerAgent(msg: string): void {
  const trimmed = msg?.trim();
  if (!trimmed) return;
  addToAgentInjectedQueue(trimmed);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent-drain");
  }
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
  const msg = `${ROOT_BUS_ID}:${content}`;
  addToAgentInjectedQueue(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("schedule-trigger", { msg });
    mainWindow.webContents.send("agent-drain");
  }
}

function runDueSchedules(): void {
  const due = getDueSchedules();
  if (due.length === 0) return;
  const ids = due.map((s) => s.id);
  deleteSchedules(ids);
  const content = buildScheduleMessage(due);
  const msg = `${ROOT_BUS_ID}:${content}`;
  addToAgentInjectedQueue(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("schedule-trigger", { msg });
    mainWindow.webContents.send("agent-drain");
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

export type AiProvider = "claude" | "openrouter" | "codex";

export interface McpConfig {
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  codexModel: string;
  /** Session-only: skip startup task and due schedules on start-chat */
  skipInitialTask?: boolean;
  /** Setup mode: expose vm_serial, vm.power_on returns setup checklist. When off: no vm_serial, vm.power_on returns stop-after; model gets bus message when VM connected. */
  setupMode?: boolean;
  /** Enable markdown parsing for message display. Off by default. */
  enableMdParsing?: boolean;
}

const DEFAULT_CONFIG: McpConfig = {
  aiProvider: "claude",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  codexModel: "gpt-5.4-codex",
  setupMode: false,
  enableMdParsing: false,
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

/** from_identifier for root bus user messages. */
function getRootUserIdentifier(): string {
  return resolveContact(ROOT_BUS_ID)?.identifier ?? "user";
}

function saveConfig(config: McpConfig): void {
  try {
    mkdirSync(APP_DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("[YAAIA] Failed to save config:", err);
  }
}

function getResourcesDir(): string {
  return app.isPackaged ? join(__dirname, "..", "resources") : join(__dirname, "..", "..", "resources");
}

function getIconPath(): string {
  return join(getResourcesDir(), "icon.png");
}

let mainWindow: BrowserWindow | null = null;

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
    // Start YaaiaVM in background so VM create/start is available on config screen
    startYaaiaVm().catch((err) => console.warn("[YAAIA] YaaiaVM background start:", err));
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopAgentServer(): void {
  stopAgent();
}

app.setPath("userData", APP_DATA_DIR);

app.whenReady().then(async () => {
  ensureStorageDirs();
  // Start YaaiaVM early so it's ready when config screen loads
  startYaaiaVm().catch((err) => console.warn("[YAAIA] YaaiaVM background start:", err));
  createMainWindow();
});

let isQuitting = false;
app.on("before-quit", async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  stopYaaiaVm();
  stopOllama();
  stopAgentServer();
  await stopMailClient();
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
  stopAgentServer();
  stopAgent();
  saveConfig(config);

  try {
    const hasAuth =
      (config.aiProvider === "claude" && config.claudeApiKey?.trim()) ||
      (config.aiProvider === "openrouter" && config.openrouterApiKey?.trim()) ||
      (config.aiProvider === "codex" && loadCodexAuth()?.access);

    if (!hasAuth) {
      return safeForIPC({
        ok: false,
        message:
          config.aiProvider === "codex"
            ? "Click 'Login with ChatGPT' to authenticate Codex first."
            : "Add API key for Claude or OpenRouter first.",
      });
    }

    clearAgentSessionApiMessages();
    recipeStore.clearPendingFinalize();
    mainWindow?.webContents?.send("startup-progress-reset");
    mainWindow?.webContents?.send("startup-progress", "Starting YaaiaVM...");
    const vmResult = await startYaaiaVm({
      onProgress: (msg) => mainWindow?.webContents?.send("startup-progress", msg),
    });
    if (!vmResult.ok) {
      console.warn("[YAAIA] YaaiaVM:", vmResult.message);
    }
    mainWindow?.webContents?.send("startup-progress", "Preparing storage...");
    setOnTelegramMessage((payload, opts) => {
      try {
        if (isWaitingForAskUser() && getWaitingAskUserBusId() === payload.bus_id) {
          deliverUserReply(payload.content, payload.bus_id);
          return;
        }
        if (isBusBanned(payload.bus_id)) {
          const peerId = parseInt(payload.bus_id.replace("telegram-", ""), 10);
          if (!isNaN(peerId)) telegramSendText(peerId, "I don't want to talk with you").catch(() => { });
          return;
        }
        const contact = resolveContact(payload.bus_id);
        if (!contact) {
          if (shouldBanBusForNoIdentity(payload.bus_id)) {
            setBusProperties(payload.bus_id, { is_banned: true });
            const peerId = parseInt(payload.bus_id.replace("telegram-", ""), 10);
            if (!isNaN(peerId)) telegramSendText(peerId, "I don't want to talk with you").catch(() => { });
            return;
          }
          incrementIdentityAttempts(payload.bus_id);
        }
        ensureBus(payload.bus_id, `Telegram: ${payload.user_name}`);
        if (payload.message_id != null && hasMessageIdInBusHistory(payload.bus_id, String(payload.message_id))) {
          return;
        }
        const storedContent = `${payload.bus_id}:${payload.content}`;
        const busMsg = {
          role: "user" as const,
          content: storedContent,
          user_id: payload.user_id,
          user_name: payload.user_name,
          bus_id: payload.bus_id,
          timestamp: payload.timestamp,
          ...(payload.message_id != null && { message_id: String(payload.message_id) }),
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
        const identityAsk = !contact
          ? `IMPORTANT: No contact exists for bus ${payload.bus_id}. Ask the user to create one via contacts.create (name, identifier, bus_ids including "${payload.bus_id}"). `
          : "";
        const instruction = `${identityAsk}${busContext}If you need more context for this bus, call bus.get_history(bus_id="${payload.bus_id}", assessment="...", clarification="...", limit=50, offset=0) for last 50, or use negative offset for earlier messages.`;
        queueAndTriggerAgent(storedContent);
        if (opts?.deliverToModel !== false && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("telegram-message", { ...payload, instruction });
        }
      } catch (err) {
        console.error("[YAAIA] Telegram callback error:", err);
      }
    });
    setOnGmailMessage((payload) => {
      try {
        if (isBusBanned(payload.bus_id)) return;
        ensureBus(payload.bus_id, `Gmail: ${payload.user_name}`);
        if (hasMessageIdInBusHistory(payload.bus_id, payload.message_id)) return;
        const storedContent = `${payload.bus_id}:${payload.content}`;
        const busMsg = {
          role: "user" as const,
          content: storedContent,
          user_name: payload.user_name,
          bus_id: payload.bus_id,
          timestamp: payload.timestamp,
          message_id: payload.message_id,
        };
        appendToBusHistory(payload.bus_id, busMsg);
        queueAndTriggerAgent(storedContent);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const isFirstFromBus = !busesDeliveredSinceRootWipe.has(payload.bus_id);
          if (isFirstFromBus) busesDeliveredSinceRootWipe.add(payload.bus_id);
          const busContext = isFirstFromBus
            ? (() => {
                const last10 = getBusHistorySlice(payload.bus_id, 10, 0);
                return last10.length ? `Recent history for ${payload.bus_id}:\n${last10.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\n` : "";
              })()
            : "";
          const instruction = `${busContext}Use gmail.users.messages.get({ userId: 'me', id: '${payload.message_id}' }) to fetch full content.`;
          mainWindow.webContents.send("email-message", { ...payload, instruction });
        }
      } catch (err) {
        console.error("[YAAIA] Gmail callback error:", err);
      }
    });
    setOnCalendarEvent((payload) => {
      try {
        if (isBusBanned(payload.bus_id)) return;
        ensureBus(payload.bus_id, "Calendar");
        if (hasEventInBusHistory(payload.bus_id, payload.event_id)) return;
        const storedContent = `${payload.bus_id}:${payload.content}`;
        const busMsg = {
          role: "user" as const,
          content: storedContent,
          user_name: "Calendar",
          bus_id: payload.bus_id,
          timestamp: payload.timestamp,
          event_uid: payload.event_id,
        };
        appendToBusHistory(payload.bus_id, busMsg);
        queueAndTriggerAgent(storedContent);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const isFirstFromBus = !busesDeliveredSinceRootWipe.has(payload.bus_id);
          if (isFirstFromBus) busesDeliveredSinceRootWipe.add(payload.bus_id);
          const busContext = isFirstFromBus
            ? (() => {
                const last10 = getBusHistorySlice(payload.bus_id, 10, 0);
                return last10.length ? `Recent history for ${payload.bus_id}:\n${last10.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\n` : "";
              })()
            : "";
          const instruction = `${busContext}Use calendar.events.get({ calendarId: '${payload.calendar_id}', eventId: '${payload.event_id}' }) to fetch full event.`;
          mainWindow.webContents.send("calendar-event", { ...payload, instruction });
        }
      } catch (err) {
        console.error("[YAAIA] Calendar callback error:", err);
      }
    });
    setOnMailMessage((payload, opts) => {
      try {
        if (isBusBanned(payload.bus_id)) return;
        const contact = resolveContact(payload.bus_id, payload.sender_email);
        if (!contact) {
          if (shouldBanBusForNoIdentity(payload.bus_id)) {
            setBusProperties(payload.bus_id, { is_banned: true });
            return;
          }
          incrementIdentityAttempts(payload.bus_id);
        }
        ensureBus(payload.bus_id, `Email: ${payload.user_name}`);
        if (payload.mail_uid != null && hasMailUidInBusHistory(payload.bus_id, payload.mail_uid)) {
          setImmediate(() => {
            mailMessageFlagsAdd(String(payload.mail_uid), ["\\Seen"], true).catch((err) =>
              console.warn("[YAAIA] Mark email as read failed:", err instanceof Error ? err.message : err)
            );
          });
          return;
        }
        const storedContent = `${payload.bus_id}:${payload.content}`;
        const busMsg = {
          role: "user" as const,
          content: storedContent,
          user_id: payload.user_id,
          user_name: payload.user_name,
          bus_id: payload.bus_id,
          timestamp: payload.timestamp,
          mail_uid: payload.mail_uid,
        };
        appendToBusHistory(payload.bus_id, busMsg);
        queueAndTriggerAgent(storedContent);
        if (payload.mail_uid != null) {
          const uid = payload.mail_uid;
          setImmediate(() => {
            mailMessageFlagsAdd(String(uid), ["\\Seen"], true).catch((err) =>
              console.warn("[YAAIA] Mark email as read failed:", err instanceof Error ? err.message : err)
            );
          });
        }
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
          const identityAsk = !contact
            ? `IMPORTANT: No contact exists for bus ${payload.bus_id} (sender: ${payload.sender_email ?? "unknown"}). Ask the user to create one via contacts.create (name, identifier="${payload.sender_email ?? "email@example.com"}", bus_ids including "${payload.bus_id}"). `
            : "";
          const instruction = `${identityAsk}${busContext}If you need more context for this bus, call bus.get_history(bus_id="${payload.bus_id}", assessment="...", clarification="...", limit=50, offset=0).`;
          mainWindow.webContents.send("email-message", { ...payload, instruction });
        }
      } catch (err) {
        console.error("[YAAIA] Mail callback error:", err);
      }
    });
    const mcpConfig = {
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
      onSendMessageToTelegram: async (busId, content) => {
        const peerId = parseInt(busId.replace("telegram-", ""), 10);
        if (!isNaN(peerId)) await telegramSendText(peerId, content);
      },
      onTelegramSearch: async (username) => {
        if (!isTelegramConnected()) {
          throw new Error("Telegram not connected. Connect Telegram via the sidebar button.");
        }
        return telegramResolvePeer(username);
      },
      appConfig: {
        telegramApiId: TELEGRAM_APP_ID,
        telegramApiHash: TELEGRAM_APP_HASH,
      },
      setupMode: config.setupMode ?? false,
    };
    setDirectToolsConfig(mcpConfig);
    ensureStorageDirs();
    ensureVmAgentInShared();
    kbEnsureCollection("history");
    mainWindow?.webContents?.send("startup-progress", "Checking Google API...");
    initGoogleBuses().catch((err) => console.warn("[YAAIA] Google buses init:", err));
    startGooglePoll();
    const storedPhone = loadTelegramConnectPhone();
    if (storedPhone && !isTelegramConnected()) {
      mainWindow?.webContents?.send("startup-progress", "Connecting Telegram...");
      telegramConnect({
        apiId: TELEGRAM_APP_ID,
        apiHash: TELEGRAM_APP_HASH,
        phone: storedPhone,
        getLoginInput: async (step) => {
          return new Promise<string>((resolve) => {
            pendingTelegramLoginResolve = resolve;
            mainWindow?.webContents?.send("telegram-login-request", { step });
          });
        },
      }).catch((err) => console.warn("[YAAIA] Telegram auto-connect:", err));
    }
    startVmEvalServer();
    setOnVmConnected(() => {
      const content = `${ROOT_BUS_ID}:VM connected for vm-bash execution`;
      queueAndTriggerAgent(content);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("agent-message", content);
      }
    });
    mcpConfig.onStartupProgress?.("Ready");
    mainWindow?.webContents?.send("startup-progress", "Starting agent...");
    const modelName =
      config.aiProvider === "claude" ? config.claudeModel : config.openrouterModel;
    recipeStore.setModel(modelName);

    const routeCallbacksBase = {
      onSendMessageToRoot: () => { /* display via stream */ },
      onSendMessageToTelegram: async (busId: string, content: string) => {
        const peerId = parseInt(busId.replace("telegram-", ""), 10);
        if (!isNaN(peerId)) await telegramSendText(peerId, content);
      },
      onAskUserRequest: (info: { clarification: string; assessment: string; attempt: number }) => {
        refocusMainWindow();
        mainWindow?.webContents?.send("ask-user-popup", info);
      },
      onAskUserTimeout: () => mainWindow?.webContents?.send("ask-user-popup-close"),
    };
    setRouteCallbacksForEval(routeCallbacksBase);
    setDeliveryCallbacks({
      onSendToRoot: (content) => mainWindow?.webContents?.send("agent-message", content),
    });

    await startAgent({
      aiProvider: config.aiProvider,
      claudeApiKey: config.claudeApiKey,
      claudeModel: config.claudeModel,
      openrouterApiKey: config.openrouterApiKey,
      openrouterModel: config.openrouterModel,
      codexModel: config.codexModel ?? "gpt-5.4-codex",
    });
    mainWindow?.webContents?.send("startup-progress", "Agent ready");

    recipeStore.setCodeBoundary(randomBytes(8).toString("base64url"));

    if (!config.skipInitialTask) {
      runStartupTask();
      runDueSchedules();
    }
    if (scheduleIntervalHandle) clearInterval(scheduleIntervalHandle);
    scheduleIntervalHandle = setInterval(runDueSchedules, 60_000);

    if (isTelegramConnected()) {
      await telegramFetchMissedMessages();
    }
    if (hasAgentInjectedMessages() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-drain");
    }
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
  setOnVmConnected(null);
  stopVmEvalServer();
  stopOllama();
  stopAgentServer();
  await stopMailClient();
  await telegramDisconnect();
  setOnTelegramMessage(null);
  setOnMailMessage(null);
  setOnGmailMessage(null);
  setOnCalendarEvent(null);
  stopGooglePoll();
  setRouteCallbacksForEval(null);
  recipeStore.clearCodeBoundary();
  clearEvalContext();
  clearAgentInjectedQueue();
  clearAgentSessionApiMessages();
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
    if (hasAgentInjectedMessages() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-drain");
    }
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

  let messageFromQueue = false;
  if (typeof message === "string" && message.trim() === "") {
    const queued = getAndClearAgentInjectedQueue();
    if (queued.length > 0) {
      message = queued.join("\n");
      messageFromQueue = true;
    } else {
      return "";
    }
  }

  /** Prior DB state only — excludes the message(s) about to be appended; synthetic HISTORY block is not persisted. */
  const { messages: priorRootForModel, trimmedCount } = getRootLogForModel(50_000);

  if (typeof message === "string" && message.includes("\n")) {
    targetBusId = ROOT_BUS_ID;
    const lines = message.split("\n");
    const parts: string[] = [];
    const readableLines: string[] = [];
    let currentEntry: {
      busId: string;
      content: string[];
      user_id: number;
      user_name: string;
      timestamp: string;
      mail_uid?: number;
      event_uid?: string;
    } | null = null;

    const flushEntry = () => {
      if (!currentEntry) return;
      const content = currentEntry.content.join("\n").trim();
      if (!content) {
        currentEntry = null;
        return;
      }
      const { busId: busIdForAppend, user_id, user_name, timestamp, mail_uid, event_uid } = currentEntry;
      const busMsg = {
        role: "user" as const,
        content,
        user_id,
        user_name,
        bus_id: busIdForAppend,
        timestamp,
        ...(mail_uid !== undefined && { mail_uid }),
        ...(event_uid && { event_uid }),
      };
      const storedContent = busIdForAppend === ROOT_BUS_ID ? `${ROOT_BUS_ID}:${content}` : `${busIdForAppend}:${content}`;
      const rootId = getRootUserIdentifier();
      if (messageFromQueue) {
        /* Queued messages were already appended to their buses by callbacks. Append to root only so model sees them; avoid duplicates. */
        appendToBusHistory(ROOT_BUS_ID, {
          ...busMsg,
          bus_id: ROOT_BUS_ID,
          from_identifier: rootId,
          content: storedContent,
        });
      } else if (busIdForAppend === ROOT_BUS_ID) {
        appendToBusHistory(ROOT_BUS_ID, {
          ...busMsg,
          bus_id: ROOT_BUS_ID,
          from_identifier: rootId,
          content: storedContent,
        });
      } else {
        ensureBus(
          busIdForAppend,
          busIdForAppend.startsWith("telegram-")
            ? `Telegram: ${user_name}`
            : busIdForAppend.startsWith("email-")
              ? `Email: ${user_name}`
              : busIdForAppend
        );
        appendToBusHistory(busIdForAppend, { ...busMsg, content: storedContent });
      }
      parts.push(`${busIdForAppend}:${content}`);
      const label =
        busIdForAppend.startsWith("telegram-")
          ? `Telegram (${user_name})`
          : busIdForAppend.startsWith("email-")
            ? `Email (${user_name})`
            : "Desktop";
      readableLines.push(`[${label}]: ${content}`);
      currentEntry = null;
    };

    for (const line of lines) {
      try {
        if (line.startsWith("{")) {
          flushEntry();
          const parsed = JSON.parse(line) as {
            content?: string;
            user_id?: number;
            user_name?: string;
            bus_id?: string;
            timestamp?: string;
            mail_uid?: number;
            event_uid?: string;
          };
          const busIdForAppend =
            parsed.bus_id && parsed.bus_id !== ROOT_BUS_ID && isValidBusIdFormat(parsed.bus_id)
              ? parsed.bus_id
              : ROOT_BUS_ID;
          const content = parsed.content ?? line;
          currentEntry = {
            busId: busIdForAppend,
            content: [content],
            user_id: parsed.user_id ?? 0,
            user_name: parsed.user_name ?? "",
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            mail_uid: parsed.mail_uid,
            event_uid: parsed.event_uid,
          };
          flushEntry();
          continue;
        }
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const maybeBusId = line.slice(0, colonIdx).trim();
          if (isValidBusIdFormat(maybeBusId)) {
            flushEntry();
            currentEntry = {
              busId: maybeBusId,
              content: [line.slice(colonIdx + 1).trimStart()],
              user_id: 0,
              user_name: "",
              timestamp: new Date().toISOString(),
            };
          } else if (currentEntry) {
            currentEntry.content.push(line);
          } else {
            currentEntry = {
              busId: ROOT_BUS_ID,
              content: [line],
              user_id: 0,
              user_name: "",
              timestamp: new Date().toISOString(),
            };
            flushEntry();
          }
        } else if (currentEntry) {
          currentEntry.content.push(line);
        } else if (line.trim()) {
          currentEntry = {
            busId: ROOT_BUS_ID,
            content: [line],
            user_id: 0,
            user_name: "",
            timestamp: new Date().toISOString(),
          };
          flushEntry();
        }
      } catch {
        /* skip malformed line */
      }
    }
    flushEntry();
    userMsg =
      readableLines.length > 0
        ? `New messages received while you were busy:\n\n${readableLines.join("\n\n")}`
        : parts.join("\n");
  } else {
    let content = message;
    let storedContent: string;
    if (targetBusId === ROOT_BUS_ID) {
      let parsed: { content?: string; user_id?: number; user_name?: string; bus_id?: string } | null = null;
      if (typeof message === "string" && message.startsWith("{")) {
        try {
          parsed = JSON.parse(message);
        } catch {
          /* fall through */
        }
      }
      if (parsed) {
        content = parsed.content ?? message;
        const user_name = parsed.user_name ?? "";
        const user_id = parsed.user_id ?? 0;
        const parsedBusId = parsed.bus_id && parsed.bus_id !== ROOT_BUS_ID ? parsed.bus_id : undefined;
        const bus_id = parsedBusId && isValidBusIdFormat(parsedBusId) ? parsedBusId : undefined;
        const rootId = getRootUserIdentifier();
        storedContent = `${ROOT_BUS_ID}:${content}`;
        appendToBusHistory(ROOT_BUS_ID, {
          role: "user",
          content: storedContent,
          user_id,
          user_name,
          from_identifier: rootId,
          ...(bus_id && { bus_id }),
        });
      } else {
        const msgStr = typeof message === "string" ? message : String(message);
        const colonIdx = msgStr.indexOf(":");
        const maybeBusId = colonIdx > 0 ? msgStr.slice(0, colonIdx).trim() : "";
        if (colonIdx > 0 && isValidBusIdFormat(maybeBusId)) {
          content = msgStr.slice(colonIdx + 1).trimStart();
          storedContent = msgStr;
        } else {
          content = msgStr;
          storedContent = `${ROOT_BUS_ID}:${content}`;
        }
        const rootId = getRootUserIdentifier();
        appendToBusHistory(ROOT_BUS_ID, {
          role: "user",
          content: storedContent,
          user_id: 0,
          user_name: "",
          from_identifier: rootId,
        });
      }
    } else {
      storedContent = `${targetBusId}:${content}`;
    }
    userMsg = storedContent;
  }
  const history = priorRootForModel.map((m) => {
    const busId = m.bus_id ?? ROOT_BUS_ID;
    const prefixContent = m.content.startsWith(`${busId}:`) ? m.content : `${busId}:${m.content}`;
    return {
      role: m.role as "user" | "assistant",
      content: prefixContent,
      db_id: m.db_id,
      timestamp: m.timestamp,
      bus_id: busId,
    };
  });
  recipeStore.setInitialPrompt(message);
  if (targetBusId !== ROOT_BUS_ID) {
    currentTargetBusIdForRun = targetBusId;
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

  const result = await doSend();

  try {
    const finalizeInfo = recipeStore.completeFinalize();
    if (finalizeInfo) {
      mainWindow?.webContents?.send("finalize-task-popup", finalizeInfo);
    }
    ensureHistoryCollection();
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

ipcMain.handle("codex-auth-status", () =>
  safeForIPC({ authenticated: !!loadCodexAuth()?.access })
);

ipcMain.handle("codex-login", async () => {
  try {
    const { url, state, verifier } = createAuthorizationFlow();
    const server = await startCodexOAuthServer();
    await shell.openExternal(url);
    const result = await server.waitForCode(state);
    server.close();
    if (!result) {
      return safeForIPC({ ok: false, error: "Login timed out or was cancelled." });
    }
    const exchange = await exchangeAuthorizationCode(result.code, verifier);
    if (!exchange.ok) {
      return safeForIPC({ ok: false, error: exchange.error });
    }
    return safeForIPC({ ok: true });
  } catch (err) {
    return safeForIPC({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

ipcMain.handle("codex-logout", () => {
  clearCodexAuth();
  return undefined;
});

ipcMain.handle("google-api-status", () =>
  safeForIPC({ authorized: isGoogleAuthorized() })
);

ipcMain.handle("google-api-authorize", async () => {
  try {
    const flow = await startGoogleOAuthFlow();
    if (!flow.ok) {
      return safeForIPC({ ok: false, error: flow.error });
    }
    await shell.openExternal(flow.url);
    const result = await flow.server.waitForCode(flow.state);
    flow.server.close();
    if (!result) {
      return safeForIPC({ ok: false, error: "Authorization timed out or was cancelled." });
    }
    const exchange = await exchangeGoogleCode(result.code);
    if (!exchange.ok) {
      return safeForIPC({ ok: false, error: exchange.error });
    }
    return safeForIPC({ ok: true });
  } catch (err) {
    return safeForIPC({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

ipcMain.handle("google-api-logout", () => {
  clearGoogleAuth();
  return undefined;
});

ipcMain.handle("telegram-connect-start", async (_event, phone: string) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: "Window not available." };
  }
  const ph = String(phone ?? "").trim();
  if (!ph) return { ok: false, error: "Phone number is required." };
  try {
    if (isTelegramConnected()) {
      return { ok: true };
    }
    await telegramConnect({
      apiId: TELEGRAM_APP_ID,
      apiHash: TELEGRAM_APP_HASH,
      phone: ph,
      getLoginInput: async (step) => {
        return new Promise<string>((resolve) => {
          pendingTelegramLoginResolve = resolve;
          mainWindow?.webContents?.send("telegram-login-request", { step });
        });
      },
    });
    saveTelegramConnectPhone(ph);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

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

ipcMain.handle("open-storage-folder", async () => {
  const storageDir = join(YAAIA_DIR, "storage");
  mkdirSync(storageDir, { recursive: true });
  await shell.openPath(storageDir);
});

ipcMain.handle("passwords-list-full", () => safeForIPC(passwordsListFull()));
ipcMain.handle(
  "passwords-set",
  (
    _,
    args: {
      description: string;
      type: "string" | "totp";
      value: string;
      force?: boolean;
      uuid?: string;
    }
  ) => {
    try {
      return passwordsSet(
        args.description,
        args.type,
        args.value,
        args.force ?? false,
        args.uuid
      );
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);
ipcMain.handle("passwords-delete", (_, id: string) => {
  passwordsDelete(id);
  return undefined;
});
ipcMain.handle("wipe-passwords", () => {
  passwordsWipe();
  return undefined;
});

ipcMain.handle("contacts-list", () => safeForIPC(contactList()));
ipcMain.handle("contacts-search", (_, query: string) => safeForIPC(contactSearch(query)));
ipcMain.handle("contacts-get", (_, idOrIdentifier: string) => safeForIPC(contactGet(idOrIdentifier)));
ipcMain.handle(
  "contacts-create",
  (
    _,
    args: { name: string; identifier: string; trust_level?: "root" | "normal"; bus_ids?: string[]; notes?: string }
  ) => {
    try {
      return contactCreate(args);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);
ipcMain.handle(
  "contacts-update",
  (
    _,
    idOrIdentifier: string,
    args: { name?: string; identifier?: string; trust_level?: "root" | "normal"; bus_ids?: string[]; notes?: string }
  ) => {
    try {
      contactUpdate(idOrIdentifier, args);
      return undefined;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);
ipcMain.handle("contacts-delete", (_, idOrIdentifier: string) => {
  try {
    contactDelete(idOrIdentifier);
    return undefined;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
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
ipcMain.handle(
  "message-bus-get-history-slice",
  (_, busId: string, limit: number, offset: number) => {
    if (busId === ROOT_BUS_ID) {
      return safeForIPC(getRootHistorySliceWithTotal(limit, offset));
    }
    const messages = getBusHistorySlice(busId, limit, offset);
    return safeForIPC({ messages, total: messages.length });
  }
);
ipcMain.handle("message-bus-wipe-root", () => {
  wipeRootHistory();
  busesDeliveredSinceRootWipe.clear();
  return undefined;
});

ipcMain.handle("message-bus-wipe-all", () => {
  wipeAllHistory();
  busesDeliveredSinceRootWipe.clear();
  return undefined;
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

ipcMain.handle("vm-list", async () => safeForIPC(await listVms()));
ipcMain.handle(
  "vm-create",
  async (_event, options?: CreateVmOptions) => safeForIPC(await createVm(options))
);
ipcMain.handle("vm-start", async (_event, vmId: string) => safeForIPC(await startVm(vmId)));
ipcMain.handle("vm-stop", async (_event, vmId: string) => safeForIPC(await stopVm(vmId)));
ipcMain.handle("vm-delete", async (_event, vmId: string) => safeForIPC(await deleteVm(vmId)));
ipcMain.handle("vm-show-console", async (_event, vmId: string) =>
  safeForIPC(await showConsoleVm(vmId))
);
ipcMain.handle("vm-pick-iso", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Select Linux ISO",
    filters: [{ name: "ISO images", extensions: ["iso"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, path: null };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle("vm-open-serial-console", async () => {
  const vms = await listVms();
  const running = vms.find((v) => v.status === "running");
  if (!running) return { ok: false, error: "No VM running" };
  let port = await getVmSerialPort(running.id);
  if (port == null) port = getVmSerialPortFromFile(running.id);
  if (port == null) return { ok: false, error: "Serial bridge not available. Restart the VM to enable it." };
  return new Promise((resolve) => {
    const cmd = `osascript -e 'tell application "Terminal" to do script "nc localhost ${port}"'`;
    exec(cmd, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
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

ipcMain.handle("agent-queue-message", (_, msg: string) => {
  const stored = msg.trim().startsWith(`${ROOT_BUS_ID}:`) ? msg.trim() : `${ROOT_BUS_ID}:${msg.trim()}`;
  const rootId = getRootUserIdentifier();
  appendToBusHistory(ROOT_BUS_ID, {
    role: "user",
    content: stored,
    user_id: 0,
    user_name: "",
    from_identifier: rootId,
  });
  addToAgentInjectedQueue(stored);
  return undefined;
});

ipcMain.handle("agent-inject-message", (_, msg: string, placeAfterAskUser?: boolean) => {
  recipeStore.appendUserInjection(msg, placeAfterAskUser ?? false);
  setPendingInjectMessage(msg);
  let content = msg;
  let busId = ROOT_BUS_ID;
  let user_name = "";
  let user_id = 0;
  if (msg.startsWith("{")) {
    try {
      const parsed = JSON.parse(msg) as { content?: string; user_id?: number; user_name?: string; bus_id?: string };
      content = parsed.content ?? msg;
      const parsedBusId = parsed.bus_id && parsed.bus_id !== ROOT_BUS_ID ? parsed.bus_id : ROOT_BUS_ID;
      busId = isValidBusIdFormat(parsedBusId) ? parsedBusId : ROOT_BUS_ID;
      user_name = parsed.user_name ?? user_name;
      user_id = parsed.user_id ?? 0;
    } catch {
      /* ignore */
    }
  } else {
    const colonIdx = msg.indexOf(":");
    if (colonIdx > 0) {
      const maybeBusId = msg.slice(0, colonIdx).trim();
      busId = isValidBusIdFormat(maybeBusId) ? maybeBusId : ROOT_BUS_ID;
      content = msg.slice(colonIdx + 1).trim();
    }
  }
  if (busId.startsWith("telegram-")) return undefined;
  const rootId = getRootUserIdentifier();
  appendToBusHistory(busId === ROOT_BUS_ID ? ROOT_BUS_ID : busId, {
    role: "user",
    content,
    user_id,
    user_name,
    ...(busId === ROOT_BUS_ID && { from_identifier: rootId }),
    ...(busId !== ROOT_BUS_ID && { bus_id: busId }),
  });
  return undefined;
});

ipcMain.handle("recipe-set-initial-prompt", (_, message: string) => {
  recipeStore.setInitialPrompt(message);
  return undefined;
});
