export interface AskUserPopupInfo {
  clarification: string;
  assessment: string;
  attempt: number;
}

export interface FinalizeTaskPopupInfo {
  is_successful: boolean;
}

export interface McpServerConfig {
  onAskUserRequest?: (info: AskUserPopupInfo) => void;
  onAskUserTimeout?: () => void;
  onStartTask?: (info: { summary: string }) => void;
  onFinalizeTask?: (info: FinalizeTaskPopupInfo) => void;
  /** Called after browser steals focus (e.g. new_page). Use to refocus the main window. */
  onRefocusMainWindow?: () => void;
  /** Called during startup with progress steps (e.g. "Connecting Playwright CLI..."). */
  onStartupProgress?: (step: string) => void;
  /** Called when agent sends message to root bus. Display in chat UI. */
  onSendMessageToRoot?: (content: string) => void;
  /** Called when agent sends message to a Telegram bus. Send via telegram client. */
  onSendMessageToTelegram?: (busId: string, content: string) => void | Promise<void>;
  /** Resolve Telegram username to bus_id. Requires Telegram to be connected (via sidebar or auto-connect on chat start). */
  onTelegramSearch?: (username: string) => Promise<{ bus_id: string; display_name?: string }>;
  /** App config. Telegram credentials exposed to eval. */
  appConfig?: {
    telegramApiId?: number;
    telegramApiHash?: string;
  };
  /** Setup mode: expose vm_serial, vm.power_on returns setup checklist. When off: no vm_serial, vm.power_on returns stop-after; model gets bus message when VM connected. */
  setupMode?: boolean;
}
