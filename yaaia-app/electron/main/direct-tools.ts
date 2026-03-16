/**
 * Direct tool implementations — bypasses MCP layer for agent code execution.
 * Same logic as MCP server handlers, called directly from agent-eval.
 */

import type { McpServerConfig } from "./mcp-server/config.js";
import * as recipeStore from "./recipe-store.js";
import {
  listBuses,
  setBusProperties,
  deleteBus,
  ensureBus,
  getBusHistorySlice,
  ROOT_BUS_ID,
} from "./message-bus-store.js";
import {
  passwordsList,
  passwordsGet,
  passwordsSet,
  passwordsDelete,
} from "./passwords-store.js";
import { addSchedule, listSchedules, getStartupTask, deleteSchedule } from "./schedule-store.js";
import { callFsToolDirect } from "./fs-direct.js";
import {
  mailConnect,
  formatImapError,
  mailInitInboxAndWatch,
  mailDisconnect,
  mailList,
  mailListTree,
  mailMailboxOpen,
  mailMailboxClose,
  mailMailboxCreate,
  mailMailboxRename,
  mailMailboxDelete,
  mailMailboxSubscribe,
  mailMailboxUnsubscribe,
  mailStatus,
  mailGetQuota,
  mailFetchAll,
  mailFetchOne,
  mailDownload,
  mailSearch,
  mailMessageDelete,
  mailMessageCopy,
  mailMessageMove,
  mailMessageFlagsAdd,
  mailMessageFlagsRemove,
  mailMessageFlagsSet,
  mailSetFlagColor,
  mailMessageLabelsAdd,
  mailMessageLabelsRemove,
  mailMessageLabelsSet,
  mailAppend,
} from "./mail-client.js";
import {
  startGoogleOAuthBrowserServer,
  caldavConnect,
  caldavDisconnect,
  caldavInitAndWatch,
  caldavListCalendars,
  caldavListEvents,
  caldavGetEvent,
  caldavCreateEvent,
  caldavUpdateEvent,
  caldavDeleteEvent,
  caldavRemoveFromLastKnown,
  parseIcsEventUid,
} from "./caldav-client.js";
import { removeEventTaskMapping } from "./caldav-event-tasks-store.js";
import {
  loadBusProperties,
  saveBusProperties,
  removeMessagesFromBusHistoryByMailUids,
  removeMessagesFromBusHistoryByEventUids,
} from "./history-store.js";
import { startVm, stopVm } from "./vm-manager.js";
import {
  identityList,
  identityGet,
  identityCreate,
  identityUpdate,
  identityDelete,
  identitySetNote,
  isBusTrusted,
} from "./identities-store.js";

let directToolsConfig: McpServerConfig | null = null;

export function setDirectToolsConfig(config: McpServerConfig | null): void {
  directToolsConfig = config;
}

export function getDirectToolsAppConfig(): McpServerConfig["appConfig"] | null {
  return directToolsConfig?.appConfig ?? null;
}

function logToolCall(toolName: string, args: unknown): void {
  const a = args as Record<string, unknown> | undefined;
  const { assessment: _a, clarification: _c, ...rest } = (a ?? {}) as Record<string, unknown>;
  if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Direct] Tool call:", toolName, JSON.stringify(rest));
}

function validateUnknownParams(args: unknown, allowedKeys: Set<string>): string | null {
  const a = args as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  const unknown = Object.keys(a).filter((k) => !allowedKeys.has(k));
  if (unknown.length === 0) return null;
  return `Unknown params: ${unknown.join(", ")}`;
}

/** Ensure assessment/clarification starts with bus_id:. Prepend defaultBus when missing. */
function ensureBusIdPrefix(s: string, defaultBus: string): string {
  if (!s.trim()) return s;
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const prefix = s.slice(0, colonIdx).trim();
    if (prefix === ROOT_BUS_ID || /^telegram-\d+$/.test(prefix) || /^email-[a-zA-Z0-9_-]+$/.test(prefix) || /^caldav-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+$/.test(prefix)) {
      return s;
    }
  }
  return `${defaultBus}: ${s}`;
}

function stripBusIdAssessmentClarification(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  delete out.bus_id;
  delete out.assessment;
  delete out.clarification;
  return out;
}

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function parseUidRange(range: string): number[] {
  const uids: number[] = [];
  for (const part of range.split(",").map((s) => s.trim())) {
    const colon = part.indexOf(":");
    if (colon >= 0) {
      const lo = parseInt(part.slice(0, colon), 10);
      const hi = parseInt(part.slice(colon + 1), 10);
      if (!isNaN(lo) && !isNaN(hi) && lo <= hi) {
        for (let i = lo; i <= hi; i++) uids.push(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) uids.push(n);
    }
  }
  return uids;
}

function contentToText(content: { type: string; text?: string; resource?: { text?: string } }[]): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "resource" && item.resource && typeof item.resource.text === "string") parts.push(item.resource.text);
  }
  return parts.join("\n").trim() || "(no output)";
}

export type AgentApiCallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

export function createDirectCallTool(): AgentApiCallTool {
  const config = directToolsConfig;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const a = args as Record<string, unknown>;
    logToolCall(name, args);

    const finish = (result: string): string => {
      if (result.startsWith("Error:")) throw new Error(result);
      return result;
    };

    try {
      switch (name) {
        case "bus.list":
        case "list_buses": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const buses = listBuses();
          const resultText = JSON.stringify(buses);
          recipeStore.appendToolCall(name, args, resultText);
          return resultText;
        }

        case "get_datetime": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const resultText = new Date().toISOString();
          recipeStore.appendToolCall(name, args, resultText);
          return resultText;
        }

        case "bus.get_history":
        case "get_bus_history": {
          const busId = String(a.bus_id ?? "root").trim() || ROOT_BUS_ID;
          const msg = validateUnknownParams(args, new Set(["bus_id", "limit", "offset"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const limit = Math.min(Math.max(0, Number(a.limit) || 50), 200);
          const offset = Number(a.offset) || 0;
          const sliced = getBusHistorySlice(busId, limit, offset);
          const resultText = JSON.stringify(sliced);
          recipeStore.appendToolCall(name, args, `Returned ${sliced.length} messages`);
          return resultText;
        }

        case "telegram_connect": {
          const msg = validateUnknownParams(args, new Set(["phone"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const phone = String(a.phone ?? "").trim();
          if (!phone) {
            recipeStore.appendToolCall(name, args, "phone is required");
            return finish("Error: phone is required.");
          }
          const result = await config?.onTelegramConnect?.(phone);
          if (!result) {
            recipeStore.appendToolCall(name, args, "Telegram connect not available");
            return finish("Error: Telegram connect not available.");
          }
          if (!result.ok) {
            recipeStore.appendToolCall(name, args, result.error ?? "Unknown error");
            return finish(`Error: ${result.error ?? "Unknown error"}`);
          }
          const buses = result.buses ?? [];
          const instruction = result.instruction ?? "If you need conversation history for a bus, call bus.get_history with bus_id in assessment prefix.";
          const missed = result.missedMessages ?? [];
          let out: string;
          if (missed.length === 0) {
            out = `Connected. Buses: ${JSON.stringify(buses)}. ${instruction}`;
          } else {
            const missedStr = missed.map((m) => `[${m.bus_id}] ${m.user_name}: ${m.content}`).join("\n");
            out = `Connected. Buses: ${JSON.stringify(buses)}. Missed messages (appended to buses):\n${missedStr}\n\n${instruction}`;
          }
          recipeStore.appendToolCall(name, args, "Connected");
          return out;
        }

        case "telegram_search": {
          const msg = validateUnknownParams(args, new Set(["username"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const searchResult = await config?.onTelegramSearch?.(String(a.username ?? ""));
          if (!searchResult) {
            recipeStore.appendToolCall(name, args, "Telegram search not available");
            return finish("Error: Telegram search not available. Connect Telegram first.");
          }
          const out = JSON.stringify(searchResult);
          recipeStore.appendToolCall(name, args, out);
          return out;
        }

        case "bus.set_properties":
        case "set_mb_properties": {
          const allowed = new Set(["mb_id", "description", "trust_level", "is_banned"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const mbId = String(a.mb_id ?? "").trim();
          if (!mbId) {
            recipeStore.appendToolCall(name, args, "mb_id is required");
            return finish("Error: mb_id is required");
          }
          if (a.is_banned === true && mbId === ROOT_BUS_ID) {
            recipeStore.appendToolCall(name, args, "Root bus cannot be banned");
            return finish("Error: Root bus cannot be banned.");
          }
          const props: { description?: string; trust_level?: "normal" | "root"; is_banned?: boolean } = {};
          if (a.description !== undefined) props.description = String(a.description).trim();
          if (a.trust_level !== undefined) props.trust_level = a.trust_level as "normal" | "root";
          if (a.is_banned !== undefined) props.is_banned = Boolean(a.is_banned);
          setBusProperties(mbId, props);
          recipeStore.appendToolCall(name, args, `Properties updated for ${mbId}`);
          return `Properties updated for ${mbId}`;
        }

        case "bus.delete":
        case "delete_bus": {
          const msg = validateUnknownParams(args, new Set(["mb_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const mbId = String(a.mb_id ?? "").trim();
          if (!mbId) {
            recipeStore.appendToolCall(name, args, "mb_id is required");
            return finish("Error: mb_id is required.");
          }
          if (mbId === ROOT_BUS_ID) {
            recipeStore.appendToolCall(name, args, "Cannot delete root bus");
            return finish("Error: Cannot delete root bus.");
          }
          deleteBus(mbId);
          recipeStore.appendToolCall(name, args, `Bus ${mbId} deleted`);
          return `Bus ${mbId} deleted`;
        }

        case "schedule.add":
        case "schedule_task": {
          const allowed = new Set(["at", "title", "instructions"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const { at, title, instructions } = a as { at: string; title: string; instructions: string };
          const entry = addSchedule(at, title, instructions);
          recipeStore.appendToolCall(name, args, `Scheduled: ${entry.id}`);
          return `Scheduled task "${title}" for ${at} (id: ${entry.id})`;
        }

        case "schedule.list":
        case "list_tasks": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const startup = getStartupTask();
          const scheduled = listSchedules();
          const resultText = JSON.stringify({ startup_task: startup, scheduled });
          recipeStore.appendToolCall(name, args, resultText);
          return resultText;
        }

        case "schedule.delete":
        case "delete_scheduled_task": {
          const msg = validateUnknownParams(args, new Set(["task_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const taskId = String(a.task_id ?? "");
          deleteSchedule(taskId);
          recipeStore.appendToolCall(name, args, `Deleted ${taskId}`);
          return `Deleted scheduled task ${taskId}`;
        }

        case "task.start":
        case "start_task": {
          const msg = validateUnknownParams(args, new Set(["summary"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const summary = String(a.summary ?? "");
          recipeStore.initFromStartTask(summary, undefined, undefined);
          config?.onStartTask?.({ summary });
          recipeStore.appendToolCall(name, args, "Task started");
          return "Task started.";
        }

        case "task.finalize":
        case "finalize_task": {
          const allowed = new Set(["is_successful", "assessment", "clarification"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const rawSuccess = a.is_successful;
          const is_successful =
            typeof rawSuccess === "boolean"
              ? rawSuccess
              : typeof rawSuccess === "string"
                ? rawSuccess.toLowerCase() !== "false" && rawSuccess.toLowerCase() !== "0"
                : true;
          const taskBus = recipeStore.getTaskBusId() ?? ROOT_BUS_ID;
          const assessment = ensureBusIdPrefix((typeof a.assessment === "string" ? a.assessment : "").trim(), taskBus);
          const clarification = ensureBusIdPrefix((typeof a.clarification === "string" ? a.clarification : "").trim(), taskBus);
          recipeStore.finalize(is_successful, assessment, clarification);
          recipeStore.appendToolCall(name, args, "Task finalized");
          return "Task finalized.";
        }

        case "passwords.list": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const list = passwordsList();
          const resultText = JSON.stringify(list);
          recipeStore.appendToolCall(name, args, resultText);
          return resultText;
        }

        case "passwords.get": {
          const msg = validateUnknownParams(args, new Set(["id", "raw"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const id = String(a.id ?? "");
          const raw = Boolean(a.raw);
          const result = await passwordsGet(id, raw);
          const resultText =
            result === null ? `Password "${id}" not found.` : result;
          recipeStore.appendToolCall(name, args, resultText);
          return resultText;
        }

        case "passwords.set": {
          const allowed = new Set(["description", "type", "value", "force", "uuid"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const a2 = a as Record<string, unknown>;
          const description = String(a2.description ?? "");
          const typeStr = String(a2.type ?? "string").toLowerCase();
          if (typeStr !== "string" && typeStr !== "totp") {
            recipeStore.appendToolCall(name, args, "type must be string or totp");
            return finish("Error: type must be string or totp");
          }
          const setUuid = passwordsSet(
            description,
            typeStr as "string" | "totp",
            String(a2.value),
            Boolean(a2.force),
            a2.uuid ? String(a2.uuid) : undefined
          );
          recipeStore.appendToolCall(name, args, `Password set: ${setUuid}`);
          return `Password set. uuid="${setUuid}"`;
        }

        case "passwords.delete": {
          const msg = validateUnknownParams(args, new Set(["id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const delId = String(a.id ?? "");
          passwordsDelete(delId);
          recipeStore.appendToolCall(name, args, `Password ${delId} deleted`);
          return `Password "${delId}" deleted.`;
        }

        case "identity.list":
        case "identity_list": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const list = identityList();
          recipeStore.appendToolCall(name, args, JSON.stringify(list));
          return JSON.stringify(list);
        }

        case "identity.get":
        case "identity_get": {
          const msg = validateUnknownParams(args, new Set(["id_or_identifier"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const idOrIdentifier = String(a.id_or_identifier ?? "").trim();
          const ident = identityGet(idOrIdentifier);
          recipeStore.appendToolCall(name, args, ident ? JSON.stringify(ident) : "null");
          return ident ? JSON.stringify(ident) : "null";
        }

        case "identity.create":
        case "identity_create": {
          const allowed = new Set(["name", "identifier", "trust_level", "bus_ids"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const { name: n, identifier: id, trust_level: tl, bus_ids: bids } = a as Record<string, unknown>;
          const createdId = identityCreate({
            name: String(n ?? ""),
            identifier: String(id ?? ""),
            trust_level: tl as "root" | "normal" | undefined,
            bus_ids: Array.isArray(bids) ? bids.map(String) : undefined,
          });
          recipeStore.appendToolCall(name, args, `Identity created: ${createdId}`);
          return `Identity created. id="${createdId}"`;
        }

        case "identity.update":
        case "identity_update": {
          const allowed = new Set(["id_or_identifier", "name", "identifier", "trust_level", "bus_ids"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const { id_or_identifier: idOrId, name: n, identifier: id, trust_level: tl, bus_ids: bids } = a as Record<string, unknown>;
          identityUpdate(String(idOrId ?? ""), {
            name: n != null ? String(n) : undefined,
            identifier: id != null ? String(id) : undefined,
            trust_level: tl as "root" | "normal" | undefined,
            bus_ids: Array.isArray(bids) ? bids.map(String) : undefined,
          });
          recipeStore.appendToolCall(name, args, "Identity updated");
          return "Identity updated.";
        }

        case "identity.delete":
        case "identity_delete": {
          const msg = validateUnknownParams(args, new Set(["id_or_identifier"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const idOrIdentifier = String(a.id_or_identifier ?? "").trim();
          identityDelete(idOrIdentifier);
          recipeStore.appendToolCall(name, args, "Identity deleted");
          return "Identity deleted.";
        }

        case "identity.set_note":
        case "identity_set_note": {
          const msg = validateUnknownParams(args, new Set(["identifier", "content"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          identitySetNote(String(a.identifier ?? ""), String(a.content ?? ""));
          recipeStore.appendToolCall(name, args, "Note saved");
          return "Note saved.";
        }

        case "identity.is_trusted":
        case "is_trusted": {
          const msg = validateUnknownParams(args, new Set(["bus_id", "sender_email"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const busId = String(a.bus_id ?? "").trim();
          const senderEmail = a.sender_email != null ? String(a.sender_email) : undefined;
          const trusted = isBusTrusted(busId, senderEmail);
          recipeStore.appendToolCall(name, args, String(trusted));
          return JSON.stringify(trusted);
        }

        case "vm.power_on": {
          const msg = validateUnknownParams(args, new Set(["vm_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const vmId = String(a.vm_id ?? "").trim();
          if (!vmId) {
            recipeStore.appendToolCall(name, args, "vm_id is required");
            return finish("Error: vm_id is required.");
          }
          const powerResult = await startVm(vmId);
          recipeStore.appendToolCall(name, args, powerResult.ok ? "Started" : powerResult.error ?? "Failed");
          if (!powerResult.ok) return finish(`Error: ${powerResult.error ?? "Failed to start VM"}`);
          return "VM started.";
        }

        case "vm.kill": {
          const msg = validateUnknownParams(args, new Set(["vm_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const vmId = String(a.vm_id ?? "").trim();
          if (!vmId) {
            recipeStore.appendToolCall(name, args, "vm_id is required");
            return finish("Error: vm_id is required.");
          }
          const killResult = await stopVm(vmId, true);
          recipeStore.appendToolCall(name, args, killResult.ok ? "Killed" : killResult.error ?? "Failed");
          if (!killResult.ok) return finish(`Error: ${killResult.error ?? "Failed to kill VM"}`);
          return "VM killed.";
        }

        default:
          if (name.startsWith("fs.")) {
            const baseName = name.replace(/^fs\./, "");
            const forwardArgs = stripBusIdAssessmentClarification(a);
            const result = await callFsToolDirect(baseName, forwardArgs);
            const text = contentToText(result.content);
            recipeStore.appendToolCall(name, args, text);
            if (result.isError) return finish(`Error: ${text}`);
            return text;
          }

          if (name.startsWith("mail.")) {
            return await handleMailTool(name, a, finish);
          }

          if (name.startsWith("caldav.")) {
            return await handleCaldavTool(name, a, finish);
          }

          recipeStore.appendToolCall(name, args, `Unknown tool: ${name}`);
          return finish(`Error: Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recipeStore.appendToolCall(name, args, msg);
      throw err;
    }
  };

  async function handleMailTool(
    toolName: string,
    a: Record<string, unknown>,
    finish: (s: string) => string
  ): Promise<string> {
    const config = directToolsConfig;
    const busId = ROOT_BUS_ID;

    try {
      switch (toolName) {
        case "mail.connect": {
          const allowed = new Set(["host", "port", "user", "pass", "secure"]);
          const msg = validateUnknownParams(a, allowed);
          if (msg) {
            recipeStore.appendToolCall(toolName, a, msg);
            return finish(msg);
          }
          const conn = a as { host: string; port: number; user: string; pass: string; secure?: boolean };
          await mailConnect({ host: conn.host, port: conn.port, user: conn.user, pass: conn.pass, secure: conn.secure });
          const { busId: mbId, messageCount } = await mailInitInboxAndWatch(conn.user);
          recipeStore.appendToolCall(toolName, a, "Connected");
          return `Connected. Bus ${mbId} created. ${messageCount} message(s) loaded.`;
        }
        case "mail.disconnect": {
          await mailDisconnect();
          recipeStore.appendToolCall(toolName, a, "Disconnected");
          return "Disconnected.";
        }
        case "mail.list": {
          const listArgs = a as { statusQuery?: Record<string, boolean> | string };
          const opts =
            listArgs.statusQuery !== undefined
              ? { statusQuery: typeof listArgs.statusQuery === "object" ? listArgs.statusQuery : {} }
              : undefined;
          const list = await mailList(opts);
          const text = JSON.stringify(list);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.list_tree": {
          const tree = await mailListTree();
          const text = JSON.stringify(tree);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.mailbox_open": {
          const open = a as { path: string; readOnly?: boolean };
          await mailMailboxOpen(open.path, open.readOnly);
          recipeStore.appendToolCall(toolName, a, "Opened");
          return `Opened ${open.path}`;
        }
        case "mail.mailbox_close": {
          await mailMailboxClose();
          recipeStore.appendToolCall(toolName, a, "Closed");
          return "Closed.";
        }
        case "mail.mailbox_create": {
          const create = a as { path: string };
          await mailMailboxCreate(create.path);
          recipeStore.appendToolCall(toolName, a, "Created");
          return "Created.";
        }
        case "mail.mailbox_rename": {
          const rename = a as { oldPath: string; newPath: string };
          await mailMailboxRename(rename.oldPath, rename.newPath);
          recipeStore.appendToolCall(toolName, a, "Renamed");
          return "Renamed.";
        }
        case "mail.mailbox_delete": {
          const del = a as { path: string };
          await mailMailboxDelete(del.path);
          recipeStore.appendToolCall(toolName, a, "Deleted");
          return "Deleted.";
        }
        case "mail.mailbox_subscribe": {
          const sub = a as { path: string };
          await mailMailboxSubscribe(sub.path);
          recipeStore.appendToolCall(toolName, a, "Subscribed");
          return "Subscribed.";
        }
        case "mail.mailbox_unsubscribe": {
          const unsub = a as { path: string };
          await mailMailboxUnsubscribe(unsub.path);
          recipeStore.appendToolCall(toolName, a, "Unsubscribed");
          return "Unsubscribed.";
        }
        case "mail.status": {
          const status = a as { path: string; query?: Record<string, boolean> | string };
          const query =
            status.query !== undefined
              ? typeof status.query === "object"
                ? status.query
                : (() => {
                    try {
                      return (typeof status.query === "string" ? JSON.parse(status.query) : {}) as Record<string, boolean>;
                    } catch {
                      return {};
                    }
                  })()
              : {};
          const statusResult = await mailStatus(status.path, query);
          const text = JSON.stringify(statusResult);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.get_quota": {
          const quota = a as { path: string };
          const quotaResult = await mailGetQuota(quota.path);
          const text = JSON.stringify(quotaResult);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.fetch_all": {
          const fetch = a as { range: string; query?: string | Record<string, unknown>; uid?: boolean; mailbox?: string };
          const query =
            fetch.query !== undefined
              ? typeof fetch.query === "object"
                ? fetch.query
                : JSON.parse(fetch.query as string)
              : { envelope: true, flags: true };
          const msgs = await mailFetchAll(fetch.range, query, { uid: fetch.uid ?? true, mailbox: fetch.mailbox });
          const text = JSON.stringify(msgs, null, 2);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.fetch_one": {
          const fetchOne = a as { seq: string; query?: string | Record<string, unknown>; uid?: boolean; mailbox?: string };
          const query =
            fetchOne.query !== undefined
              ? typeof fetchOne.query === "object"
                ? fetchOne.query
                : JSON.parse(fetchOne.query as string)
              : { envelope: true, flags: true, source: true };
          const msg = await mailFetchOne(fetchOne.seq, query, { uid: fetchOne.uid ?? true, mailbox: fetchOne.mailbox });
          const text = JSON.stringify(msg, null, 2);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.download": {
          const dl = a as { range: string; part?: string; uid?: boolean; mailbox?: string };
          const result = await mailDownload(dl.range, dl.part || "", { uid: dl.uid ?? true, mailbox: dl.mailbox });
          recipeStore.appendToolCall(toolName, a, result);
          return result;
        }
        case "mail.search": {
          const search = a as { query: string | Record<string, unknown>; uid?: boolean; mailbox?: string };
          const query =
            typeof search.query === "object" ? search.query : JSON.parse(search.query as string);
          const uids = await mailSearch(query, { uid: search.uid ?? true, mailbox: search.mailbox });
          const text = JSON.stringify(uids);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.message_delete": {
          const del = a as { range: string; uid?: boolean; mailbox?: string };
          if (del.mailbox) await mailMailboxOpen(del.mailbox);
          await mailMessageDelete(del.range, del.uid ?? true);
          if (busId.startsWith("email-")) {
            const uids = parseUidRange(del.range);
            if (uids.length > 0) removeMessagesFromBusHistoryByMailUids(busId, uids);
          }
          recipeStore.appendToolCall(toolName, a, "Deleted");
          return "Deleted.";
        }
        case "mail.message_copy": {
          const copy = a as { range: string; destination: string; uid?: boolean; mailbox?: string };
          if (copy.mailbox) await mailMailboxOpen(copy.mailbox);
          const copyResult = await mailMessageCopy(copy.range, copy.destination, copy.uid ?? true);
          const text = JSON.stringify(copyResult);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.message_move": {
          const move = a as { range: string; destination: string; uid?: boolean; mailbox?: string };
          if (move.mailbox) await mailMailboxOpen(move.mailbox);
          const moveResult = await mailMessageMove(move.range, move.destination, move.uid ?? true);
          const text = JSON.stringify(moveResult);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "mail.message_flags_add": {
          const flagsAdd = a as { range: string; flags: string | string[]; uid?: boolean; mailbox?: string };
          if (flagsAdd.mailbox) await mailMailboxOpen(flagsAdd.mailbox);
          await mailMessageFlagsAdd(flagsAdd.range, toStrArray(flagsAdd.flags), flagsAdd.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.message_flags_remove": {
          const flagsRem = a as { range: string; flags: string | string[]; uid?: boolean; mailbox?: string };
          if (flagsRem.mailbox) await mailMailboxOpen(flagsRem.mailbox);
          await mailMessageFlagsRemove(flagsRem.range, toStrArray(flagsRem.flags), flagsRem.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.message_flags_set": {
          const flagsSet = a as { range: string; flags: string | string[]; uid?: boolean; mailbox?: string };
          if (flagsSet.mailbox) await mailMailboxOpen(flagsSet.mailbox);
          await mailMessageFlagsSet(flagsSet.range, toStrArray(flagsSet.flags), flagsSet.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.set_flag_color": {
          const color = a as { range: string; color: string; uid?: boolean; mailbox?: string };
          if (color.mailbox) await mailMailboxOpen(color.mailbox);
          await mailSetFlagColor(color.range, color.color, color.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.message_labels_add": {
          const labelsAdd = a as { range: string; labels: string | string[]; uid?: boolean; mailbox?: string };
          if (labelsAdd.mailbox) await mailMailboxOpen(labelsAdd.mailbox);
          await mailMessageLabelsAdd(labelsAdd.range, toStrArray(labelsAdd.labels), labelsAdd.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.message_labels_remove": {
          const labelsRem = a as { range: string; labels: string | string[]; uid?: boolean; mailbox?: string };
          if (labelsRem.mailbox) await mailMailboxOpen(labelsRem.mailbox);
          await mailMessageLabelsRemove(labelsRem.range, toStrArray(labelsRem.labels), labelsRem.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.message_labels_set": {
          const labelsSet = a as { range: string; labels: string | string[]; uid?: boolean; mailbox?: string };
          if (labelsSet.mailbox) await mailMailboxOpen(labelsSet.mailbox);
          await mailMessageLabelsSet(labelsSet.range, toStrArray(labelsSet.labels), labelsSet.uid ?? true);
          recipeStore.appendToolCall(toolName, a, "Done");
          return "Done.";
        }
        case "mail.append": {
          const append = a as { path: string; content: string; flags?: string | string[]; idate?: string };
          const appendResult = await mailAppend(append.path, append.content, append.flags ? toStrArray(append.flags) : undefined, append.idate);
          const appendText = JSON.stringify(appendResult);
          recipeStore.appendToolCall(toolName, a, appendText);
          return appendText;
        }
        default:
          recipeStore.appendToolCall(toolName, a, `Unknown mail tool: ${toolName}`);
          return finish(`Error: Unknown mail tool: ${toolName}`);
      }
    } catch (err) {
      const msg = formatImapError(err);
      recipeStore.appendToolCall(toolName, a, msg);
      return finish(`Error: ${msg}`);
    }
  }

  async function handleCaldavTool(
    toolName: string,
    a: Record<string, unknown>,
    finish: (s: string) => string
  ): Promise<string> {
    const config = directToolsConfig;
    const busId = ROOT_BUS_ID;

    try {
      switch (toolName) {
        case "caldav.oauth_browser": {
          const msg = validateUnknownParams(a, new Set());
          if (msg) {
            recipeStore.appendToolCall(toolName, a, msg);
            return finish(msg);
          }
          const clientId = config?.appConfig?.caldavGoogleClientId?.trim();
          const clientSecret = config?.appConfig?.caldavGoogleClientSecret?.trim();
          if (!clientId || !clientSecret) {
            recipeStore.appendToolCall(toolName, a, "Configure CalDAV Google Client ID and Secret");
            return finish("Error: Configure CalDAV Google Client ID and Secret in app settings first.");
          }
          const { url } = await startGoogleOAuthBrowserServer(clientId, clientSecret);
          recipeStore.appendToolCall(toolName, a, url);
          return url;
        }
        case "caldav.connect": {
          const allowed = new Set(["authMethod", "serverUrl", "username", "password", "provider", "refreshToken", "credentials_password_id"]);
          const msg = validateUnknownParams(a, allowed);
          if (msg) {
            recipeStore.appendToolCall(toolName, a, msg);
            return finish(msg);
          }
          const conn = a as {
            authMethod: "Basic" | "OAuth";
            serverUrl?: string;
            username?: string;
            password?: string;
            provider?: string;
            refreshToken?: string;
            credentials_password_id?: string;
          };
          const clientId = config?.appConfig?.caldavGoogleClientId?.trim();
          const clientSecret = config?.appConfig?.caldavGoogleClientSecret?.trim();
          let account: string;
          if (conn.authMethod === "OAuth") {
            if (!clientId || !clientSecret) {
              recipeStore.appendToolCall(toolName, a, "Configure CalDAV Google Client ID and Secret");
              return finish("Error: Configure CalDAV Google Client ID and Secret in app settings first.");
            }
            let refreshToken = conn.refreshToken;
            let username = conn.username;
            if (conn.credentials_password_id) {
              const pwd = await passwordsGet(conn.credentials_password_id);
              const pwdValue = typeof pwd === "string" ? pwd : pwd && typeof pwd === "object" && "value" in pwd ? (pwd as { value: string }).value : null;
              if (pwdValue) {
                try {
                  const cred = JSON.parse(pwdValue as string) as { refreshToken?: string; username?: string };
                  refreshToken = refreshToken ?? cred.refreshToken;
                  username = username ?? cred.username;
                } catch {
                  /* ignore */
                }
              }
            }
            await caldavConnect(
              {
                authMethod: "OAuth",
                provider: "google",
                refreshToken: refreshToken ?? "",
                username: username ?? "",
                clientId,
                clientSecret,
              },
              { googleClientId: clientId, googleClientSecret: clientSecret }
            );
            account = username || "google";
          } else {
            if (!conn.serverUrl || !conn.username || !conn.password) {
              recipeStore.appendToolCall(toolName, a, "Basic auth requires serverUrl, username, password");
              return finish("Error: Basic auth requires serverUrl, username, password");
            }
            await caldavConnect({
              authMethod: "Basic",
              serverUrl: conn.serverUrl,
              username: conn.username,
              password: conn.password,
            });
            account = conn.username!;
          }
          const { calendars } = await caldavInitAndWatch(account);
          for (const cal of calendars) {
            ensureBus(cal.busId, `Calendar: ${cal.displayName}`);
            const props = loadBusProperties(cal.busId);
            if (props) saveBusProperties({ ...props, url: cal.url });
          }
          recipeStore.appendToolCall(toolName, a, "Connected");
          return `Connected. Bus(es): ${calendars.map((c) => c.busId).join(", ")}`;
        }
        case "caldav.disconnect": {
          await caldavDisconnect();
          recipeStore.appendToolCall(toolName, a, "Disconnected");
          return "Disconnected.";
        }
        case "caldav.list_calendars": {
          const calList = await caldavListCalendars();
          const text = JSON.stringify(calList);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "caldav.list_events": {
          const events = a as { calendarUrl: string; start: string; end: string };
          const eventList = await caldavListEvents(events.calendarUrl, events.start, events.end);
          const text = JSON.stringify(eventList);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "caldav.get_event": {
          const getEv = a as { calendarUrl: string; objectUrl: string };
          const ev = await caldavGetEvent(getEv.calendarUrl, getEv.objectUrl);
          const text = JSON.stringify(ev);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        case "caldav.create_event": {
          const createEv = a as { calendarUrl: string; filename: string; iCalString: string };
          await caldavCreateEvent(createEv.calendarUrl, createEv.filename, createEv.iCalString);
          recipeStore.appendToolCall(toolName, a, "Event created");
          return "Event created.";
        }
        case "caldav.update_event": {
          const updateEv = a as { calendarObject: string };
          await caldavUpdateEvent(updateEv.calendarObject);
          recipeStore.appendToolCall(toolName, a, "Event updated");
          return "Event updated.";
        }
        case "caldav.delete_event": {
          const deleteEv = a as { calendarObject: string };
          const obj = JSON.parse(deleteEv.calendarObject) as { url: string; etag?: string; data?: string };
          await caldavDeleteEvent(obj);
          const eventUid = typeof obj.data === "string" ? parseIcsEventUid(obj.data) : undefined;
          if (eventUid) {
            removeEventTaskMapping(eventUid);
            removeMessagesFromBusHistoryByEventUids(busId, [eventUid]);
            config?.onCaldavEventDeleted?.(eventUid, busId);
          }
          caldavRemoveFromLastKnown(obj.url);
          recipeStore.appendToolCall(toolName, a, "Deleted");
          return "Event deleted.";
        }
        case "caldav.status": {
          const statusResult = await caldavListCalendars();
          const text = JSON.stringify(statusResult);
          recipeStore.appendToolCall(toolName, a, text);
          return text;
        }
        default:
          recipeStore.appendToolCall(toolName, a, `Unknown caldav tool: ${toolName}`);
          return finish(`Error: Unknown caldav tool: ${toolName}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recipeStore.appendToolCall(toolName, a, msg);
      return finish(`Error: ${msg}`);
    }
  }
}
