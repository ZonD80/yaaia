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
}
