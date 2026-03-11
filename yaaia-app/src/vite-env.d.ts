/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ElectronAPI {
  getConfig: () => Promise<{
    aiProvider: string;
    claudeApiKey: string;
    claudeModel: string;
    openrouterApiKey: string;
    openrouterModel: string;
    telegramAppId: string;
    telegramApiHash: string;
    userName: string;
  }>;
  startChat: (config: unknown) => Promise<{ ok: boolean; agentReady?: boolean; message: string }>;
  stopChat: () => Promise<{ ok: boolean }>;
  agentSendMessage: (message: string, history?: { role: string; content: string }[], busId?: string) => Promise<string>;
  agentAbort: () => Promise<void>;
  askUserReply: (reply: string) => Promise<void>;
  askUserCancel: () => Promise<void>;
  recipeView: () => Promise<void>;
  recipeSave: () => Promise<string | null>;
  recipeLoad: () => Promise<{ ok: boolean; markdown?: string; error?: string }>;
  agentInjectMessage: (message: string, placeAfterAskUser?: boolean) => Promise<void>;
  secretsListFull: () => Promise<unknown[]>;
  secretsSet: (args: unknown) => Promise<string>;
  secretsDelete: (id: string) => Promise<void>;
  wipeSecrets: () => Promise<void>;
  agentConfigList: () => Promise<unknown[]>;
  agentConfigSet: (args: unknown) => Promise<string>;
  agentConfigDelete: (id: string) => Promise<void>;
  wipeConfigs: () => Promise<void>;
  messageBusList: () => Promise<Array<{ bus_id: string; description: string }>>;
  messageBusSetDescription: (busId: string, description: string) => Promise<void>;
  messageBusDelete: (busId: string) => Promise<void>;
  messageBusGetHistory: (busId: string) => Promise<Array<{ role: string; content: string }>>;
  messageBusWipeRoot: () => Promise<void>;
  kbList: (path?: string, recursive?: boolean) => Promise<string[]>;
  kbRead: (path: string) => Promise<string>;
  kbWrite: (path: string, content: string) => Promise<void>;
  kbDelete: (path: string) => Promise<void>;
  scheduleList: () => Promise<Array<{ id: string; at: string; title: string; instructions: string; created_at: string }>>;
  scheduleGetStartup: () => Promise<{ title: string; instructions: string }>;
  scheduleSetStartup: (task: { title: string; instructions: string }) => Promise<void>;
  scheduleAdd: (at: string, title: string, instructions: string) => Promise<{ id: string; at: string; title: string; instructions: string; created_at: string }>;
  scheduleUpdate: (id: string, props: { at?: string; title?: string; instructions?: string }) => Promise<unknown>;
  scheduleDelete: (id: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  onAgentStreamChunk: (callback: (chunk: string) => void) => () => void;
  onAskUserPopup: (callback: (info: { clarification: string; assessment: string; attempt: number }) => void) => () => void;
  onAskUserPopupClose: (callback: () => void) => () => void;
  onTaskStart: (callback: (info: { summary: string }) => void) => () => void;
  onFinalizeTaskPopup: (callback: (info: { assessment: string; clarification: string; is_successful: boolean; detailed_report: string }) => void) => () => void;
  onAgentBrowserError: (callback: (message: string) => void) => () => void;
  onStartupProgress: (callback: (step: string) => void) => () => void;
  onStartupProgressReset: (callback: () => void) => () => void;
  onAgentMessage: (callback: (content: string) => void) => () => void;
  onTelegramMessage: (callback: (payload: { bus_id: string; user_id: number; user_name: string; content: string }) => void) => () => void;
  onScheduleTrigger: (callback: (message: string) => void) => () => void;
  onTelegramLoginRequest: (callback: (info: { step: "phone" | "code" | "password" }) => void) => () => void;
  telegramLoginReply: (value: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
