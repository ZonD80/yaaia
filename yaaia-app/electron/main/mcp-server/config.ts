export interface AskUserPopupInfo {
  clarification: string;
  assessment: string;
  attempt: number;
}

export interface FinalizeTaskPopupInfo {
  assessment: string;
  clarification: string;
  is_successful: boolean;
  detailed_report: string;
}

export interface McpServerConfig {
  onAskUserRequest?: (info: AskUserPopupInfo) => void;
  onAskUserTimeout?: () => void;
  onStartTask?: (info: { summary: string }) => void;
  onFinalizeTask?: (info: FinalizeTaskPopupInfo) => void;
  /** Called after Chrome steals focus (e.g. new_page). Use to refocus the main window. */
  onRefocusMainWindow?: () => void;
  /** Called during startup with progress steps (e.g. "Connecting Chrome MCP..."). */
  onStartupProgress?: (step: string) => void;
  /** Called when agent sends message to root bus. Display in chat UI. */
  onSendMessageToRoot?: (content: string) => void;
  /** Called when agent sends message to any bus (for tracking). */
  onSendMessage?: (busId: string) => void;
  /** Called when agent sends message to a Telegram bus. Send via telegram client. */
  onSendMessageToTelegram?: (busId: string, content: string) => void | Promise<void>;
  /** Called when agent wants to connect Telegram. phone is mandatory from the tool. Returns buses + instruction on success. */
  onTelegramConnect?: (phone: string) => Promise<{
    ok: boolean;
    buses?: Array<{ bus_id: string; description: string }>;
    instruction?: string;
    missedMessages?: Array<{ bus_id: string; user_id: number; user_name: string; content: string }>;
    error?: string;
  }>;
  /** Resolve Telegram username to bus_id. Requires Telegram to be connected. */
  onTelegramSearch?: (username: string) => Promise<{ bus_id: string; display_name?: string }>;
  /** App config for root bus (userName). Telegram credentials are read from config, not passed here. */
  appConfig?: { userName: string };
}
