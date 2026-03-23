import { contextBridge, ipcRenderer } from "electron";

export type AiProvider = "claude" | "openrouter" | "codex";

export interface McpConfig {
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  codexModel: string;
  skipInitialTask?: boolean;
  enableMdParsing?: boolean;
}

try {
  contextBridge.exposeInMainWorld("electronAPI", {
    getConfig: () => ipcRenderer.invoke("get-config"),
    startChat: (config: McpConfig) => ipcRenderer.invoke("start-chat", config),
    stopChat: () => ipcRenderer.invoke("stop-chat"),
    agentSendMessage: (message: string, history?: { role: "user" | "assistant"; content: string }[], busId?: string) =>
      ipcRenderer.invoke("agent-send-message", message, history ?? [], busId),
    agentAbort: () => ipcRenderer.invoke("agent-abort"),
    askUserReply: (reply: string) => ipcRenderer.invoke("ask-user-reply", reply),
    askUserCancel: () => ipcRenderer.invoke("ask-user-cancel"),
    recipeView: () => ipcRenderer.invoke("recipe-view"),
    recipeSave: () => ipcRenderer.invoke("recipe-save"),
    recipeLoad: () => ipcRenderer.invoke("recipe-load"),
    agentQueueMessage: (message: string) => ipcRenderer.invoke("agent-queue-message", message),
    agentInjectMessage: (message: string, placeAfterAskUser?: boolean) =>
      ipcRenderer.invoke("agent-inject-message", message, placeAfterAskUser),
    passwordsListFull: () => ipcRenderer.invoke("passwords-list-full"),
    passwordsSet: (args: {
      description: string;
      type: "string" | "totp";
      value: string;
      force?: boolean;
      uuid?: string;
    }) => ipcRenderer.invoke("passwords-set", args),
    passwordsDelete: (id: string) => ipcRenderer.invoke("passwords-delete", id),
    wipePasswords: () => ipcRenderer.invoke("wipe-passwords"),
    contactsList: () => ipcRenderer.invoke("contacts-list"),
    contactsSearch: (query: string) => ipcRenderer.invoke("contacts-search", query),
    contactsGet: (idOrIdentifier: string) => ipcRenderer.invoke("contacts-get", idOrIdentifier),
    contactsCreate: (args: {
      name: string;
      identifier: string;
      trust_level?: "root" | "normal";
      bus_ids?: string[];
      notes?: string;
    }) => ipcRenderer.invoke("contacts-create", args),
    contactsUpdate: (
      idOrIdentifier: string,
      args: { name?: string; identifier?: string; trust_level?: "root" | "normal"; bus_ids?: string[]; notes?: string }
    ) => ipcRenderer.invoke("contacts-update", idOrIdentifier, args),
    contactsDelete: (idOrIdentifier: string) => ipcRenderer.invoke("contacts-delete", idOrIdentifier),
    messageBusList: () => ipcRenderer.invoke("message-bus-list"),
    messageBusSetDescription: (busId: string, description: string) =>
      ipcRenderer.invoke("message-bus-set-description", busId, description),
    messageBusDelete: (busId: string) => ipcRenderer.invoke("message-bus-delete", busId),
    messageBusGetHistory: (busId: string) => ipcRenderer.invoke("message-bus-get-history", busId),
    messageBusGetHistorySlice: (busId: string, limit: number, offset: number) =>
      ipcRenderer.invoke("message-bus-get-history-slice", busId, limit, offset),
    messageBusWipeRoot: () => ipcRenderer.invoke("message-bus-wipe-root"),
    messageBusWipeAll: () => ipcRenderer.invoke("message-bus-wipe-all"),
    scheduleList: () => ipcRenderer.invoke("schedule-list"),
    scheduleGetStartup: () => ipcRenderer.invoke("schedule-get-startup"),
    scheduleSetStartup: (task: { title: string; instructions: string }) =>
      ipcRenderer.invoke("schedule-set-startup", task),
    scheduleAdd: (at: string, title: string, instructions: string) =>
      ipcRenderer.invoke("schedule-add", at, title, instructions),
    scheduleUpdate: (id: string, props: { at?: string; title?: string; instructions?: string }) =>
      ipcRenderer.invoke("schedule-update", id, props),
    scheduleDelete: (id: string) => ipcRenderer.invoke("schedule-delete", id),
    openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
    openStorageFolder: () => ipcRenderer.invoke("open-storage-folder"),
    onAgentStreamChunk: (callback: (chunk: string) => void) => {
      const fn = (_: unknown, chunk: string) => callback(chunk);
      ipcRenderer.on("agent-stream-chunk", fn);
      return () => ipcRenderer.removeListener("agent-stream-chunk", fn);
    },
    onAskUserPopup: (callback: (info: { clarification: string; assessment: string; attempt: number }) => void) => {
      const fn = (_: unknown, info: { clarification: string; assessment: string; attempt: number }) => callback(info);
      ipcRenderer.on("ask-user-popup", fn);
      return () => ipcRenderer.removeListener("ask-user-popup", fn);
    },
    onAskUserPopupClose: (callback: () => void) => {
      const fn = () => callback();
      ipcRenderer.on("ask-user-popup-close", fn);
      return () => ipcRenderer.removeListener("ask-user-popup-close", fn);
    },
    onTaskStart: (callback: (info: { summary: string }) => void) => {
      const fn = (_: unknown, info: { summary: string }) => callback(info);
      ipcRenderer.on("task-start", fn);
      return () => ipcRenderer.removeListener("task-start", fn);
    },
    onFinalizeTaskPopup: (callback: (info: { is_successful: boolean }) => void) => {
      const fn = (_: unknown, info: { is_successful: boolean }) => callback(info);
      ipcRenderer.on("finalize-task-popup", fn);
      return () => ipcRenderer.removeListener("finalize-task-popup", fn);
    },
    onStartupProgress: (callback: (step: string) => void) => {
      const fn = (_: unknown, step: string) => callback(step);
      ipcRenderer.on("startup-progress", fn);
      return () => ipcRenderer.removeListener("startup-progress", fn);
    },
    onStartupProgressReset: (callback: () => void) => {
      const fn = () => callback();
      ipcRenderer.on("startup-progress-reset", fn);
      return () => ipcRenderer.removeListener("startup-progress-reset", fn);
    },
    onAgentMessage: (callback: (content: string) => void) => {
      const fn = (_: unknown, content: string) => callback(content);
      ipcRenderer.on("agent-message", fn);
      return () => ipcRenderer.removeListener("agent-message", fn);
    },
    onTelegramMessage: (callback: (payload: { bus_id: string; user_id: number; user_name: string; content: string }) => void) => {
      const fn = (_: unknown, payload: { bus_id: string; user_id: number; user_name: string; content: string }) => callback(payload);
      ipcRenderer.on("telegram-message", fn);
      return () => ipcRenderer.removeListener("telegram-message", fn);
    },
    onEmailMessage: (callback: (payload: { bus_id: string; user_id: number; user_name: string; content: string; instruction?: string }) => void) => {
      const fn = (_: unknown, payload: { bus_id: string; user_id: number; user_name: string; content: string; instruction?: string }) => callback(payload);
      ipcRenderer.on("email-message", fn);
      return () => ipcRenderer.removeListener("email-message", fn);
    },
    onCalendarEvent: (callback: (payload: { bus_id: string; content: string; instruction?: string; timestamp?: string }) => void) => {
      const fn = (_: unknown, payload: { bus_id: string; content: string; instruction?: string; timestamp?: string }) => callback(payload);
      ipcRenderer.on("calendar-event", fn);
      return () => ipcRenderer.removeListener("calendar-event", fn);
    },
    onScheduleTrigger: (callback: (message: string) => void) => {
      const fn = (_: unknown, message: string) => callback(message);
      ipcRenderer.on("schedule-trigger", fn);
      return () => ipcRenderer.removeListener("schedule-trigger", fn);
    },
    onAgentDrain: (callback: (payload?: string) => void) => {
      const fn = (_: unknown, payload?: string) => callback(payload);
      ipcRenderer.on("agent-drain", fn);
      return () => ipcRenderer.removeListener("agent-drain", fn);
    },
    onTelegramLoginRequest: (callback: (info: { step: "phone" | "code" | "password" }) => void) => {
      const fn = (_: unknown, info: { step: "phone" | "code" | "password" }) => callback(info);
      ipcRenderer.on("telegram-login-request", fn);
      return () => ipcRenderer.removeListener("telegram-login-request", fn);
    },
    telegramLoginReply: (value: string) => ipcRenderer.invoke("telegram-login-reply", value),
    codexAuthStatus: () => ipcRenderer.invoke("codex-auth-status"),
    codexLogin: () => ipcRenderer.invoke("codex-login"),
    codexLogout: () => ipcRenderer.invoke("codex-logout"),
    googleApiStatus: () => ipcRenderer.invoke("google-api-status"),
    googleApiAuthorize: () => ipcRenderer.invoke("google-api-authorize"),
    telegramConnectStart: (phone: string) => ipcRenderer.invoke("telegram-connect-start", phone),
    googleApiLogout: () => ipcRenderer.invoke("google-api-logout"),
    vmList: () => ipcRenderer.invoke("vm-list"),
    vmCreate: (options?: { isoPath?: string; ramMb?: number; diskGb?: number }) =>
      ipcRenderer.invoke("vm-create", options),
    vmStart: (vmId: string) => ipcRenderer.invoke("vm-start", vmId),
    vmStop: (vmId: string) => ipcRenderer.invoke("vm-stop", vmId),
    vmDelete: (vmId: string) => ipcRenderer.invoke("vm-delete", vmId),
    vmShowConsole: (vmId: string) => ipcRenderer.invoke("vm-show-console", vmId),
    vmPickIso: () => ipcRenderer.invoke("vm-pick-iso"),
    vmOpenSerialConsole: () => ipcRenderer.invoke("vm-open-serial-console"),
  });
} catch (err) {
  console.error("[YAAIA preload] Failed to expose electronAPI:", err);
}
