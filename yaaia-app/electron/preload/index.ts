import { contextBridge, ipcRenderer } from "electron";

export type AiProvider = "claude" | "openrouter";

export interface McpConfig {
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  telegramAppId: string;
  telegramApiHash: string;
  userName: string;
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
    agentInjectMessage: (message: string, placeAfterAskUser?: boolean) =>
      ipcRenderer.invoke("agent-inject-message", message, placeAfterAskUser),
    secretsListFull: () => ipcRenderer.invoke("secrets-list-full"),
    secretsSet: (args: {
      detailed_description: string;
      first_factor: string;
      first_factor_type: string;
      value: string;
      totp_secret?: string;
      force?: boolean;
    }) => ipcRenderer.invoke("secrets-set", args),
    secretsDelete: (id: string) => ipcRenderer.invoke("secrets-delete", id),
    wipeSecrets: () => ipcRenderer.invoke("wipe-secrets"),
    agentConfigList: () => ipcRenderer.invoke("agent-config-list"),
    agentConfigSet: (args: { detailed_description: string; value: string; force?: boolean }) =>
      ipcRenderer.invoke("agent-config-set", args),
    agentConfigDelete: (id: string) => ipcRenderer.invoke("agent-config-delete", id),
    wipeConfigs: () => ipcRenderer.invoke("wipe-configs"),
    messageBusList: () => ipcRenderer.invoke("message-bus-list"),
    messageBusSetDescription: (busId: string, description: string) =>
      ipcRenderer.invoke("message-bus-set-description", busId, description),
    messageBusDelete: (busId: string) => ipcRenderer.invoke("message-bus-delete", busId),
    messageBusGetHistory: (busId: string) => ipcRenderer.invoke("message-bus-get-history", busId),
    messageBusWipeRoot: () => ipcRenderer.invoke("message-bus-wipe-root"),
    kbList: (path?: string, recursive?: boolean) => ipcRenderer.invoke("kb-list", path ?? ".", recursive ?? true),
    kbRead: (path: string) => ipcRenderer.invoke("kb-read", path),
    kbWrite: (path: string, content: string) => ipcRenderer.invoke("kb-write", path, content),
    kbDelete: (path: string) => ipcRenderer.invoke("kb-delete", path),
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
    onFinalizeTaskPopup: (callback: (info: { assessment: string; clarification: string; is_successful: boolean; detailed_report: string }) => void) => {
      const fn = (_: unknown, info: { assessment: string; clarification: string; is_successful: boolean }) => callback(info);
      ipcRenderer.on("finalize-task-popup", fn);
      return () => ipcRenderer.removeListener("finalize-task-popup", fn);
    },
    onAgentBrowserError: (callback: (message: string) => void) => {
      const fn = (_: unknown, message: string) => callback(message);
      ipcRenderer.on("agent-browser-error", fn);
      return () => ipcRenderer.removeListener("agent-browser-error", fn);
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
    onScheduleTrigger: (callback: (message: string) => void) => {
      const fn = (_: unknown, message: string) => callback(message);
      ipcRenderer.on("schedule-trigger", fn);
      return () => ipcRenderer.removeListener("schedule-trigger", fn);
    },
    onTelegramLoginRequest: (callback: (info: { step: "phone" | "code" | "password" }) => void) => {
      const fn = (_: unknown, info: { step: "phone" | "code" | "password" }) => callback(info);
      ipcRenderer.on("telegram-login-request", fn);
      return () => ipcRenderer.removeListener("telegram-login-request", fn);
    },
    telegramLoginReply: (value: string) => ipcRenderer.invoke("telegram-login-reply", value),
  });
} catch (err) {
  console.error("[YAAIA preload] Failed to expose electronAPI:", err);
}
