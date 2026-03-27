/**
 * TypeScript API for agent code execution.
 * Messaging: use console.log('bus_id:content') — captured and routed to buses.
 */

export type AgentApiRouteCallbacksBase = {
  onAskUserRequest?: (info: { clarification: string; assessment: string; attempt: number }) => void;
  onAskUserTimeout?: () => void;
};
import {
  connectVmSerial,
  readVmSerial,
  writeVmSerial,
  disconnectVmSerial,
  sendFileToVmSerial,
} from "./vm-serial.js";
import { generateModuleHelp, type AgentHelpModule } from "./agent-api-docs.js";
import type { MemoryEvalContext } from "./memory-store.js";

/** JSDoc param shapes for memory.* tools (agent-api.ts source of truth for spec generator). */
type MemoryProvenanceArg = {
  source_bus_id?: string;
  source_db_id?: number;
  source_external_message_id?: string;
  source_contact_id?: string;
  provenance_note?: string;
  references_memory_ids?: number[];
};

type MemoryListArg = {
  kind?: string;
  tags?: string[];
  body_substring?: string;
  source_bus_id?: string;
  source_contact_id?: string;
  source_db_id?: number;
  from_timestamp?: string;
  to_timestamp?: string;
  limit?: number;
  offset?: number;
};

export type AgentApiCallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

function defineModuleHelp(obj: object, module: AgentHelpModule, opts: { setupMode: boolean; codeBoundary: string | null }): void {
  Object.defineProperty(obj, "help", {
    value: () => generateModuleHelp(module, opts),
    enumerable: false,
    configurable: true,
  });
}

export type AgentApiRouteCallbacks = AgentApiRouteCallbacksBase & {
  emitChunk?: (chunk: string) => void;
};

export interface AppConfig {
  telegramApiId?: number;
  telegramApiHash?: string;
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
  /** Persistent vm-bash stdout buffers per user. vmEvalStdout.root, vmEvalStdout[user_id]. Append-only, cleared on stop-chat. */
  vmEvalStdout?: Record<string, string>;
  /** Persistent vm-bash stderr buffers per user. vmEvalStderr.root, vmEvalStderr[user_id]. Append-only, cleared on stop-chat. */
  vmEvalStderr?: Record<string, string>;
  /** Setup mode: expose vm_serial. When false, vm_serial is not available. */
  setupMode?: boolean;
  /** Bbtag boundary for `.help()` text; defaults from recipe in eval. */
  codeBoundary?: string | null;
  /** Per-eval memory buffers + ids for memory.* provenance (source_db_id 0 resolution). */
  memoryEval?: MemoryEvalContext;
}

/**
 * Create the API object to inject into the eval sandbox.
 * Messaging: use console.log('bus_id:content') — captured and routed to buses.
 */
export function createAgentApi(deps: AgentApiDeps): Record<string, unknown> {
  const { callTool } = deps;
  if (!callTool) throw new Error("callTool required");

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await callTool(name, args);
    return result;
  };

  const appConfig = deps.appConfig ?? null;

  const helpOpts = {
    setupMode: deps.setupMode ?? false,
    codeBoundary: deps.codeBoundary ?? null,
  };

  const api: Record<string, unknown> = {
    // App config (Telegram apiId/apiHash, CalDAV Google client id/secret)
    app_config: appConfig,

    /** List all message buses. */
    bus: {
      list: () => call("bus.list", {}),
      /**
       * Fetch message history. bus_id `root` merges all buses by time.
       * Params: limit (default 50, max 200), offset. Optional from_timestamp, to_timestamp (ISO-8601 received_at bounds), from_id (SQLite messages.id, inclusive lower bound).
       */
      get_history: (args: {
        bus_id: string;
        limit?: number;
        offset?: number;
        from_timestamp?: string;
        to_timestamp?: string;
        from_id?: number;
      }) =>
        call("bus.get_history", {
          bus_id: args.bus_id,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          ...(args.from_timestamp != null && String(args.from_timestamp).trim() !== ""
            ? { from_timestamp: String(args.from_timestamp).trim() }
            : {}),
          ...(args.to_timestamp != null && String(args.to_timestamp).trim() !== ""
            ? { to_timestamp: String(args.to_timestamp).trim() }
            : {}),
          ...(args.from_id != null && Number.isFinite(Number(args.from_id)) ? { from_id: Number(args.from_id) } : {}),
        }),
      set_properties: (args: {
        mb_id: string;
        description?: string;
        trust_level?: "normal" | "root";
        is_banned?: boolean;
      }) => call("bus.set_properties", args),
      delete: (args: { mb_id: string }) => call("bus.delete", args),
      /** Outgoing Telegram voice call to the user for this `telegram-<id>` bus. */
      call: (args: { bus_id: string; timeout_ms?: number }) =>
        call("bus.call", {
          bus_id: args.bus_id,
          ...(args.timeout_ms != null && Number.isFinite(Number(args.timeout_ms)) ? { timeout_ms: Number(args.timeout_ms) } : {}),
        }),
      /** Accept incoming ring for this caller bus (matches incoming-call notification). */
      pickup: (args: { bus_id: string }) => call("bus.pickup", { bus_id: args.bus_id }),
      /** End the active VoIP call. Optional bus_id must match the active call if provided. */
      hangup: (args: { bus_id?: string }) =>
        call("bus.hangup", {
          ...(args.bus_id != null && String(args.bus_id).trim() !== "" ? { bus_id: String(args.bus_id).trim() } : {}),
        }),
      /** Decline a ringing call, or end active call if it matches this bus. */
      reject: (args: { bus_id: string }) => call("bus.reject", { bus_id: args.bus_id }),
    },

    // Contacts (name, identifier, trust_level, bus_ids, notes)
    contacts: {
      list: () => call("contacts.list", {}),
      search: (args: { query: string }) => call("contacts.search", args),
      get: (args: { id_or_identifier?: string; identifier?: string }) => call("contacts.get", args),
      create: (args: {
        name: string;
        identifier: string;
        trust_level?: "normal" | "root";
        bus_ids?: string[];
        notes?: string;
      }) => call("contacts.create", args),
      update: (args: {
        id_or_identifier?: string;
        name?: string;
        identifier?: string;
        trust_level?: "normal" | "root";
        bus_ids?: string[];
        notes?: string;
      }) => call("contacts.update", args),
      delete: (args: { id_or_identifier?: string; identifier?: string }) => call("contacts.delete", args),
      is_trusted: (args: { bus_id: string; sender_email?: string }) => call("contacts.is_trusted", args),
    },

    // Soul (SOUL.md in yaaia folder — agent identity, appended to system prompt)
    soul: {
      get: () => call("soul.get", {}),
      set: (args: { content: string }) => call("soul.set", args),
    },

    memory: {
      /**
       * Insert or upsert (by key) a global memory row. Provenance is set on create; key upserts update body/kind/tags only.
       * Params: provenance.source_db_id — SQLite messages.id; use 0 for this assistant message once id is known.
       */
      put: (args: {
        kind?: string;
        body: string;
        tags?: string[];
        key?: string;
        provenance?: MemoryProvenanceArg;
      }) =>
        call("memory.put", {
          kind: args.kind,
          body: args.body,
          tags: args.tags,
          key: args.key,
          provenance: args.provenance ?? {},
        }),
      /** Get one memory by id (negative ids are eval-pending rows). */
      get: (args: { id: number }) => call("memory.get", args),
      /**
       * List with optional filters.
       * Params: kind?, tags?, body_substring?, source_bus_id?, source_contact_id?, source_db_id? (0 = pending assistant rows in eval), from_timestamp?, to_timestamp?, limit?, offset?
       */
      list: (args?: MemoryListArg) => call("memory.list", args ?? {}),
      /** Delete by id. */
      delete: (args: { id: number }) => call("memory.delete", args),
      /**
       * Search body by FTS5 (default) or LIKE. v1 only — phase 2 may add vectors.
       * Params: query (required), mode?: fts|like, limit?
       */
      find: (args: { query: string; mode?: "fts" | "like"; limit?: number }) => call("memory.find", args),
      /** Persist markdown shown at top of memory.help(). */
      set_help: (args: { text: string }) => call("memory.set_help", args),
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

    // Telegram (connect via sidebar; auto-connects on chat start if previously connected)
    /** Resolve username to bus_id. Params: username (required) */
    telegram_search: (args: { username: string }) => call("telegram_search", args),

    // VM power control (vmControl avoids conflict with Node's vm module in sandbox)
    vmControl: {
      /** Power on a VM. Params: vm_id (required) */
      power_on: (args: { vm_id: string }) => call("vm.power_on", args),
      /** Force-kill a VM. Shut down the VM with shutdown -h now (via vm_serial) before killing. Params: vm_id (required) */
      kill: (args: { vm_id: string }) => call("vm.kill", args),
    },

    // VM serial (Linux VM console) — only in setup mode
    ...(deps.setupMode
      ? {
          vm_serial: {
            connect: async (args: { vm_id: string }) => {
              const r = await connectVmSerial(args.vm_id);
              return r.ok ? "Connected to VM serial console." : `Error: ${r.error ?? "Failed"}`;
            },
            read: async (args: { vm_id: string }) =>
              readVmSerial(args.vm_id, true) || "(no output yet)",
            write_from_file: async (args: { vm_id: string; path: string }) => {
              const r = sendFileToVmSerial(args.vm_id, args.path);
              return r.ok ? "Sent." : `Error: ${r.error ?? "Failed"}`;
            },
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
            disconnect: async (args: { vm_id: string }) => {
              disconnectVmSerial(args.vm_id);
              return "Disconnected.";
            },
          },
        }
      : {}),
  };

  defineModuleHelp(api.bus as object, "bus", helpOpts);
  defineModuleHelp(api.contacts as object, "contacts", helpOpts);
  defineModuleHelp(api.soul as object, "soul", helpOpts);
  defineModuleHelp(api.passwords as object, "passwords", helpOpts);
  defineModuleHelp(api.schedule as object, "schedule", helpOpts);
  defineModuleHelp(api.task as object, "task", helpOpts);
  defineModuleHelp(api.mail as object, "mail", helpOpts);
  defineModuleHelp(api.vmControl as object, "vmControl", helpOpts);
  if (api.vm_serial) defineModuleHelp(api.vm_serial as object, "vm_serial", helpOpts);
  defineModuleHelp(api.telegram_search as object, "telegram_search", helpOpts);
  defineModuleHelp(api.memory as object, "memory", helpOpts);

  return api;
}
