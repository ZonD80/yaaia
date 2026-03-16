/**
 * TypeScript API for agent code execution.
 * TypeScript API for the eval sandbox. Wraps tools and routeMessage.
 */

import type { ParsedMessage, RouteCallbacks } from "./message-router.js";
import { parsePrefixedMessages, routeMessage } from "./message-router.js";
import { ROOT_BUS_ID } from "./message-bus-store.js";
import {
  connectVmSerial,
  readVmSerial,
  writeVmSerial,
  disconnectVmSerial,
  sendFileToVmSerial,
} from "./vm-serial.js";

export type AgentApiCallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

export type AgentApiRouteCallbacks = RouteCallbacks & {
  emitChunk?: (chunk: string) => void;
};

export interface AppConfig {
  userName?: string;
  telegramApiId?: number;
  telegramApiHash?: string;
  caldavGoogleClientId?: string;
  caldavGoogleClientSecret?: string;
}

export interface AgentApiDeps {
  /** When omitted, agent-eval creates it via createDirectCallTool(page). */
  callTool?: AgentApiCallTool;
  routeCallbacks: AgentApiRouteCallbacks;
  /** App config (Telegram, CalDAV OAuth) exposed to eval. When omitted, agent-eval fetches from direct-tools. */
  appConfig?: AppConfig | null;
  /** Returns queued injected messages (formatted) and clears queue. Used to include in eval result. */
  getInjectedMessages?: () => { formatted: string; raw: string } | null;
  /** Called when eval produces console output (stdout/stderr). Used to stream eval output to chat. */
  onOutputChunk?: (text: string) => void;
}

/**
 * Create the API object to inject into the eval sandbox.
 * Model uses send_message for progress; no assessment/clarification on tool calls.
 */
export function createAgentApi(deps: AgentApiDeps): Record<string, unknown> {
  const { callTool, routeCallbacks } = deps;
  if (!callTool) throw new Error("callTool required");

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await callTool(name, args);
    return result;
  };

  const sendMessage = async (content: string): Promise<string> => {
    const parsed = parsePrefixedMessages(content);
    const msg = parsed[0];
    if (!msg) throw new Error("send_message: content must use prefix format bus_id:content");

    const displayContent = msg.busId === ROOT_BUS_ID ? msg.content : `[${msg.busId}] ${msg.content}`;
    routeCallbacks.emitChunk?.("<<<MSG>>>" + JSON.stringify({ type: "send_message", content: displayContent }) + "<<<END>>>");

    const routed: ParsedMessage = { ...msg, waitForAnswer: false };
    const res = await routeMessage(routed, routeCallbacks);
    if (res.error) throw new Error(res.error);
    return `Sent to ${msg.busId}`;
  };

  const ask = async (prompt: string): Promise<string> => {
    const parsed = parsePrefixedMessages(prompt);
    const msg = parsed[0];
    if (!msg) throw new Error("ask: prompt must use prefix format bus_id:prompt or bus_id:wait:prompt");

    if (msg.busId !== ROOT_BUS_ID && !msg.busId.startsWith("telegram-")) {
      throw new Error("ask only supports root or telegram buses");
    }

    const displayContent = msg.busId === ROOT_BUS_ID ? msg.content : `[${msg.busId}] ${msg.content}`;
    routeCallbacks.emitChunk?.("<<<MSG>>>" + JSON.stringify({ type: "send_message", content: displayContent }) + "<<<END>>>");

    const routed: ParsedMessage = { ...msg, waitForAnswer: true };
    const res = await routeMessage(routed, routeCallbacks);
    if (res.error) throw new Error(res.error);
    return res.reply ?? "User did not reply in time.";
  };

  const appConfig = deps.appConfig ?? null;

  return {
    // App config (Telegram apiId/apiHash, CalDAV Google client id/secret)
    app_config: appConfig,

    // FS (paths relative to fs root /)
    fs: {
      /** Read file content. Params: path (required) */
      read_file: (args: { path: string }) => call("fs.read_file", args),
      /** Write or overwrite file. Params: path (required), content (required) */
      write_file: (args: { path: string; content: string }) => call("fs.write_file", args),
      /** Append content to file. Params: path (required), content (required) */
      append_file: (args: { path: string; content: string }) => call("fs.append_file", args),
      /** Replace lines in file. Params: path (required), content (required), from_line (0-based), to_line (-1=end) */
      replace_file: (args: { path: string; content: string; from_line?: number; to_line?: number }) =>
        call("fs.replace_file", args),
      /** Update file content (overwrite). Params: path (required), content (required) */
      update_file: (args: { path: string; content: string }) => call("fs.update_file", args),
      /** List files in directory. Params: path (required) */
      list_files: (args: { path: string }) => call("fs.list_files", args),
      /** Delete a file. Params: path (required) */
      delete_file: (args: { path: string }) => call("fs.delete_file", args),
      /** Delete a directory. Params: path (required) */
      delete_directory: (args: { path: string }) => call("fs.delete_directory", args),
      /** Create a directory. Params: path (required) */
      create_directory: (args: { path: string }) => call("fs.create_directory", args),
      /** Move file or directory. Params: source (required), destination (required) */
      move_path: (args: { source: string; destination: string }) => call("fs.move_path", args),
      /** Copy file or directory. Params: source (required), destination (required) */
      copy_path: (args: { source: string; destination: string }) => call("fs.copy_path", args),
    },

    // Messaging
    send_message: sendMessage,
    ask,

    /** List all message buses. */
    bus: {
      list: () => call("bus.list", {}),
      get_history: (args: { bus_id: string; limit?: number; offset?: number }) =>
        call("bus.get_history", {
          bus_id: args.bus_id,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
        }),
      set_properties: (args: {
        mb_id: string;
        description?: string;
        trust_level?: "normal" | "root";
        is_banned?: boolean;
      }) => call("bus.set_properties", args),
      delete: (args: { mb_id: string }) => call("bus.delete", args),
    },

    // Identities (name, identifier, trust_level, bus_ids; note per identity)
    identity: {
      list: () => call("identity.list", {}),
      get: (args: { id_or_identifier: string }) => call("identity.get", args),
      create: (args: {
        name: string;
        identifier: string;
        trust_level?: "normal" | "root";
        bus_ids?: string[];
      }) => call("identity.create", args),
      update: (args: {
        id_or_identifier: string;
        name?: string;
        identifier?: string;
        trust_level?: "normal" | "root";
        bus_ids?: string[];
      }) => call("identity.update", args),
      delete: (args: { id_or_identifier: string }) => call("identity.delete", args),
      set_note: (args: { identifier: string; content: string }) => call("identity.set_note", args),
      is_trusted: (args: { bus_id: string; sender_email?: string }) => call("identity.is_trusted", args),
    },

    // Passwords (passwords and TOTPs only; usernames, hosts, ports in KB md files)
    passwords: {
      /** List passwords. */
      list: () => call("passwords.list", {}),
      /** Get a password by uuid or description. For totp: returns OTP code by default; raw=true returns the seed. Params: id (uuid or description), raw? (optional) */
      get: (args: { id: string; raw?: boolean }) => call("passwords.get", args),
      /** Set a password. Params: description (required), type (string|totp), value (required), force? (optional), uuid? (optional, for update) */
      set: (args: {
        description: string;
        type: "string" | "totp";
        value: string;
        force?: boolean;
        uuid?: string;
      }) => call("passwords.set", args),
      /** Delete a password. Params: id (uuid or description) */
      delete: (args: { id: string }) => call("passwords.delete", args),
    },

    // Schedule
    schedule: {
      add: (args: { at: string; title: string; instructions: string }) =>
        call("schedule.add", args),
      list: () => call("schedule.list", {}),
      delete: (args: { task_id: string }) => call("schedule.delete", args),
    },

    // Tasks
    task: {
      start: (args: { summary: string }) => call("task.start", args),
      finalize: (args: { is_successful: boolean }) => call("task.finalize", args),
    },

    // Utils
    /** Get current ISO datetime. */
    get_datetime: () => call("get_datetime", {}),

    // Mail
    mail: {
      /** Connect to IMAP. Params: host, port, user, pass (required), secure? (optional) */
      connect: (args: {
        host: string;
        port: number;
        user: string;
        pass: string;
        secure?: boolean;
      }) => call("mail.connect", args),
      /** Disconnect from IMAP. */
      disconnect: () => call("mail.disconnect", {}),
      /** List mailboxes. Params: statusQuery? (optional) */
      list: (args?: { statusQuery?: string }) => call("mail.list", args ?? {}),
      /** List mailbox tree. */
      list_tree: () => call("mail.list_tree", {}),
      /** Open mailbox. Params: path (required), readOnly? (optional) */
      mailbox_open: (args: { path: string; readOnly?: boolean }) =>
        call("mail.mailbox_open", args),
      /** Close mailbox. */
      mailbox_close: () => call("mail.mailbox_close", {}),
      /** Create mailbox. Params: path (required) */
      mailbox_create: (args: { path: string }) => call("mail.mailbox_create", args),
      /** Rename mailbox. Params: oldPath, newPath (required) */
      mailbox_rename: (args: { oldPath: string; newPath: string }) =>
        call("mail.mailbox_rename", args),
      /** Delete mailbox. Params: path (required) */
      mailbox_delete: (args: { path: string }) => call("mail.mailbox_delete", args),
      /** Subscribe to mailbox. Params: path (required) */
      mailbox_subscribe: (args: { path: string }) => call("mail.mailbox_subscribe", args),
      /** Unsubscribe from mailbox. Params: path (required) */
      mailbox_unsubscribe: (args: { path: string }) => call("mail.mailbox_unsubscribe", args),
      /** Get mailbox status. Params: path (required), query? (optional) */
      status: (args: { path: string; query?: string }) => call("mail.status", args),
      /** Get quota. Params: path (required) */
      get_quota: (args: { path: string }) => call("mail.get_quota", args),
      /** Fetch messages. Params: range (required), query? (object or JSON string), uid?, mailbox? (optional) */
      fetch_all: (args: {
        range: string;
        query?: string | Record<string, unknown>;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.fetch_all", args),
      /** Fetch one message. Params: seq (required), query? (object or JSON string), uid?, mailbox? (optional) */
      fetch_one: (args: {
        seq: string;
        query?: string | Record<string, unknown>;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.fetch_one", args),
      /** Download attachment. Params: range (required), part?, uid?, mailbox? (optional) */
      download: (args: {
        range: string;
        part?: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.download", args),
      /** Search messages. Params: query (required, object or JSON string), uid?, mailbox? (optional) */
      search: (args: { query: string | Record<string, unknown>; uid?: boolean; mailbox?: string }) =>
        call("mail.search", args),
      /** Delete message(s). Params: range (required), uid?, mailbox? (optional) */
      message_delete: (args: { range: string; uid?: boolean; mailbox?: string }) =>
        call("mail.message_delete", args),
      /** Copy message(s). Params: range, destination (required), uid?, mailbox? (optional) */
      message_copy: (args: {
        range: string;
        destination: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_copy", args),
      /** Move message(s). Params: range, destination (required), uid?, mailbox? (optional) */
      message_move: (args: {
        range: string;
        destination: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_move", args),
      /** Add flags. Params: range, flags (required), uid?, mailbox? (optional) */
      message_flags_add: (args: {
        range: string;
        flags: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_flags_add", args),
      /** Remove flags. Params: range, flags (required), uid?, mailbox? (optional) */
      message_flags_remove: (args: {
        range: string;
        flags: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_flags_remove", args),
      /** Set flags. Params: range, flags (required), uid?, mailbox? (optional) */
      message_flags_set: (args: {
        range: string;
        flags: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_flags_set", args),
      /** Set flag color. Params: range, color (required), uid?, mailbox? (optional) */
      set_flag_color: (args: {
        range: string;
        color: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.set_flag_color", args),
      /** Add labels. Params: range, labels (required), uid?, mailbox? (optional) */
      message_labels_add: (args: {
        range: string;
        labels: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_labels_add", args),
      /** Remove labels. Params: range, labels (required), uid?, mailbox? (optional) */
      message_labels_remove: (args: {
        range: string;
        labels: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_labels_remove", args),
      /** Set labels. Params: range, labels (required), uid?, mailbox? (optional) */
      message_labels_set: (args: {
        range: string;
        labels: string;
        uid?: boolean;
        mailbox?: string;
      }) => call("mail.message_labels_set", args),
      /** Append message. Params: path, content (required), flags?, idate? (optional) */
      append: (args: { path: string; content: string; flags?: string; idate?: string }) =>
        call("mail.append", args),
    },

    // CalDAV
    caldav: {
      /** Get OAuth URL for Google CalDAV. Returns URL string; user opens in browser. */
      oauth_browser: () => call("caldav.oauth_browser", {}),
      /** Connect to CalDAV. Params: authMethod (Basic|OAuth), serverUrl?, username?, password?, provider?, refreshToken?, credentials_password_id? (for OAuth) */
      connect: (args: {
        authMethod: "Basic" | "OAuth";
        serverUrl?: string;
        username?: string;
        password?: string;
        provider?: string;
        refreshToken?: string;
        credentials_password_id?: string;
      }) => call("caldav.connect", args),
      /** Disconnect from CalDAV. */
      disconnect: () => call("caldav.disconnect", {}),
      /** List calendars. */
      list_calendars: () => call("caldav.list_calendars", {}),
      /** List events in range. Params: calendarUrl, start, end (required) */
      list_events: (args: { calendarUrl: string; start: string; end: string }) =>
        call("caldav.list_events", args),
      /** Get event by URL. Params: calendarUrl, objectUrl (required) */
      get_event: (args: { calendarUrl: string; objectUrl: string }) =>
        call("caldav.get_event", args),
      /** Create event. Params: calendarUrl, filename, iCalString (required) */
      create_event: (args: {
        calendarUrl: string;
        filename: string;
        iCalString: string;
      }) => call("caldav.create_event", args),
      /** Update event. Params: calendarObject (required) */
      update_event: (args: { calendarObject: string }) => call("caldav.update_event", args),
      /** Delete event. Params: calendarObject (required) */
      delete_event: (args: { calendarObject: string }) => call("caldav.delete_event", args),
      /** Get connection status. */
      status: () => call("caldav.status", {}),
    },

    // Telegram
    /** Connect to Telegram. Params: phone (required) */
    telegram_connect: (args: { phone: string }) => call("telegram_connect", args),
    /** Resolve username to bus_id. Params: username (required) */
    telegram_search: (args: { username: string }) => call("telegram_search", args),

    // VM power control
    vm: {
      /** Power on a VM. Params: vm_id (required) */
      power_on: (args: { vm_id: string }) => call("vm.power_on", args),
      /** Force-kill a VM. Shut down the VM with shutdown -h now (via vm_serial) before killing. Params: vm_id (required) */
      kill: (args: { vm_id: string }) => call("vm.kill", args),
    },

    // VM serial (Linux VM console)
    vm_serial: {
      /** Connect to VM serial console. Params: vm_id (required) */
      connect: async (args: { vm_id: string }) => {
        const r = await connectVmSerial(args.vm_id);
        return r.ok ? "Connected to VM serial console." : `Error: ${r.error ?? "Failed"}`;
      },
      /** Read buffered output from VM serial. Params: vm_id (required) */
      read: async (args: { vm_id: string }) =>
        readVmSerial(args.vm_id, true) || "(no output yet)",
      /** Write file content to VM serial (raw, no escaping). Path relative to fs root. Use for large bash scripts. Params: vm_id (required), path (required) */
      write_from_file: async (args: { vm_id: string; path: string }) => {
        const r = sendFileToVmSerial(args.vm_id, args.path);
        return r.ok ? "Sent." : `Error: ${r.error ?? "Failed"}`;
      },
      /** Send text/keystrokes to VM serial. Use chars for unambiguous control (each element = one char). Params: vm_id (required), data? (string), chars? (string[]), raw? (boolean) */
      write: async (args: {
        vm_id: string;
        data?: string;
        chars?: string[];
        raw?: boolean;
      }) => {
        const { vm_id, data, chars, raw } = args;
        const opts = chars != null && chars.length > 0 ? { chars } : data != null ? { data, raw } : undefined;
        if (!opts) return "Error: data or chars is required";
        const r = writeVmSerial(vm_id, opts);
        return r.ok ? "Sent." : `Error: ${r.error ?? "Failed"}`;
      },
      /** Disconnect from VM serial. Params: vm_id (required) */
      disconnect: async (args: { vm_id: string }) => {
        disconnectVmSerial(args.vm_id);
        return "Disconnected.";
      },
    },
  };
}
