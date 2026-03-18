/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ElectronAPI {
  getConfig: () => Promise<{
    aiProvider: string;
    claudeApiKey: string;
    claudeModel: string;
    openrouterApiKey: string;
    openrouterModel: string;
    userName: string;
    rootUserIdentifier?: string;
    rootUserIdentifierDefined?: boolean;
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
  agentQueueMessage: (message: string) => Promise<void>;
  agentInjectMessage: (message: string, placeAfterAskUser?: boolean) => Promise<void>;
  passwordsListFull: () => Promise<unknown[]>;
  passwordsSet: (args: unknown) => Promise<string>;
  passwordsDelete: (id: string) => Promise<void>;
  wipePasswords: () => Promise<void>;
  identityList: () => Promise<Array<{ id: string; name: string; identifier: string; trust_level: string; bus_ids: string[] }>>;
  identityGet: (idOrIdentifier: string) => Promise<{ id: string; name: string; identifier: string; trust_level: string; bus_ids: string[]; note: string } | null>;
  identityCreate: (args: { name: string; identifier: string; trust_level?: "root" | "normal"; bus_ids?: string[] }) => Promise<string>;
  identityUpdate: (idOrIdentifier: string, args: { name?: string; identifier?: string; trust_level?: "root" | "normal"; bus_ids?: string[] }) => Promise<void>;
  identityDelete: (idOrIdentifier: string) => Promise<void>;
  identitySetNote: (identifier: string, content: string) => Promise<void>;
  messageBusList: () => Promise<Array<{ bus_id: string; description: string }>>;
  messageBusSetDescription: (busId: string, description: string) => Promise<void>;
  messageBusDelete: (busId: string) => Promise<void>;
  messageBusGetHistory: (busId: string) => Promise<Array<{ role: string; content: string; user_name?: string; timestamp?: string }>>;
  messageBusGetHistorySlice: (
    busId: string,
    limit: number,
    offset: number
  ) => Promise<{ messages: Array<{ role: string; content: string; user_name?: string; bus_id?: string; timestamp?: string }>; total: number }>;
  messageBusWipeRoot: () => Promise<void>;
  scheduleList: () => Promise<Array<{ id: string; at: string; title: string; instructions: string; created_at: string }>>;
  scheduleGetStartup: () => Promise<{ title: string; instructions: string }>;
  scheduleSetStartup: (task: { title: string; instructions: string }) => Promise<void>;
  scheduleAdd: (at: string, title: string, instructions: string) => Promise<{ id: string; at: string; title: string; instructions: string; created_at: string }>;
  scheduleUpdate: (id: string, props: { at?: string; title?: string; instructions?: string }) => Promise<unknown>;
  scheduleDelete: (id: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  openStorageFolder: () => Promise<void>;
  onAgentStreamChunk: (callback: (chunk: string) => void) => () => void;
  onAskUserPopup: (callback: (info: { clarification: string; assessment: string; attempt: number }) => void) => () => void;
  onAskUserPopupClose: (callback: () => void) => () => void;
  onTaskStart: (callback: (info: { summary: string }) => void) => () => void;
  onFinalizeTaskPopup: (callback: (info: { is_successful: boolean }) => void) => () => void;
  onStartupProgress: (callback: (step: string) => void) => () => void;
  onStartupProgressReset: (callback: () => void) => () => void;
  onAgentMessage: (callback: (content: string) => void) => () => void;
  onTelegramMessage: (callback: (payload: { bus_id: string; user_id: number; user_name: string; content: string }) => void) => () => void;
  onEmailMessage: (callback: (payload: { bus_id: string; user_id: number; user_name: string; content: string; instruction?: string }) => void) => () => void;
  onScheduleTrigger: (callback: (payload: { msg: string; injectHandled?: boolean } | string) => void) => () => void;
  onAgentDrain: (callback: (payload?: string) => void) => () => void;
  onTelegramLoginRequest: (callback: (info: { step: "phone" | "code" | "password" }) => void) => () => void;
  telegramLoginReply: (value: string) => Promise<void>;
  codexAuthStatus: () => Promise<{ authenticated: boolean }>;
  codexLogin: () => Promise<{ ok: boolean; error?: string }>;
  codexLogout: () => Promise<void>;
  googleApiStatus: () => Promise<{ authorized: boolean }>;
  googleApiAuthorize: () => Promise<{ ok: boolean; error?: string }>;
  googleApiLogout: () => Promise<void>;
  vmList: () => Promise<Array<{ id: string; name: string; path: string; status: string; ramMb: number; diskGb: number }>>;
  vmCreate: (options?: { isoPath?: string; ramMb?: number; diskGb?: number }) => Promise<{ ok: boolean; vmId?: string; error?: string }>;
  vmStart: (vmId: string) => Promise<void>;
  vmStop: (vmId: string) => Promise<void>;
  vmDelete: (vmId: string) => Promise<void>;
  vmShowConsole: (vmId: string) => Promise<void>;
  vmPickIso: () => Promise<string | null>;
  vmOpenSerialConsole: () => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export { };
