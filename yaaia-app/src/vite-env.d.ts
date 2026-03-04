/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ElectronAPI {
  getConfig: () => Promise<{
    aiProvider: string;
    claudeApiKey: string;
    claudeModel: string;
    openrouterApiKey: string;
    openrouterModel: string;
  }>;
  startChat: (config: unknown) => Promise<{ ok: boolean; agentReady?: boolean; message: string }>;
  stopChat: () => Promise<{ ok: boolean }>;
  agentSendMessage: (message: string, history?: { role: string; content: string }[]) => Promise<string>;
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
  openExternal: (url: string) => Promise<void>;
  onAgentStreamChunk: (callback: (chunk: string) => void) => () => void;
  onAskUserPopup: (callback: (info: { clarification: string; assessment: string; attempt: number }) => void) => () => void;
  onAskUserPopupClose: (callback: () => void) => () => void;
  onTaskStart: (callback: (info: { summary: string }) => void) => () => void;
  onFinalizeTaskPopup: (callback: (info: { assessment: string; clarification: string; is_successful: boolean; detailed_report: string }) => void) => () => void;
  onAgentBrowserError: (callback: (message: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
