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
  getHistoryDb,
} from "./message-db.js";
import {
  memoryPut,
  memoryGet,
  memoryList,
  memoryDelete,
  memoryFind,
  getMemoryHelpText,
  setMemoryHelpText,
  type MemoryEvalContext,
  type MemoryProvenance,
  type MemoryListFilter,
} from "./memory-store.js";
import {
  passwordsList,
  passwordsGet,
  passwordsSet,
  passwordsDelete,
} from "./passwords-store.js";
import { addSchedule, listSchedules, getStartupTask, deleteSchedule } from "./schedule-store.js";
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
  loadBusProperties,
  saveBusProperties,
  removeMessagesFromBusHistoryByMailUids,
  removeMessagesFromBusHistoryByEventUids,
} from "./message-db.js";
import { startVm, stopVm } from "./vm-manager.js";
import { isVmEvalConnected } from "./vm-eval-server.js";
import {
  contactList,
  contactGet,
  contactCreate,
  contactUpdate,
  contactDelete,
  contactSearch,
  isBusTrusted,
} from "./contacts-store.js";
import { soulGet, soulSet } from "./soul-store.js";
import { isTelegramConnected, parseTelegramBusPeerId } from "./telegram-client.js";

async function gatewayTelegramVoip(path: string, body: Record<string, unknown>): Promise<Response> {
  const base = (process.env.YAAIA_TG_GATEWAY_URL ?? "http://127.0.0.1:37567").replace(/\/$/, "");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = process.env.YAAIA_TG_GATEWAY_TOKEN?.trim();
  if (t) h.Authorization = `Bearer ${t}`;
  return fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: h });
}

let directToolsConfig: McpServerConfig | null = null;

function telegramBusIdFromArgs(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("telegram-")) return null;
  return parseTelegramBusPeerId(s) != null ? s : null;
}

/** Thrown by vm.power_on in non-setup mode to abort eval. Caught in agent-eval. */
export class VmPowerOnAbortError extends Error {
  constructor() {
    super("vm.power_on abort");
    this.name = "VmPowerOnAbortError";
  }
}

export function setDirectToolsConfig(config: McpServerConfig | null): void {
  directToolsConfig = config;
}

export function getDirectToolsAppConfig(): McpServerConfig["appConfig"] | null {
  return directToolsConfig?.appConfig ?? null;
}

export function getDirectToolsSetupMode(): boolean {
  return directToolsConfig?.setupMode ?? false;
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

/** Which contact to load: `id_or_identifier` wins; if omitted, `identifier` is used (same shape as contacts.create). */
function contactLookupKey(a: Record<string, unknown>): string {
  const primary = String(a.id_or_identifier ?? "").trim();
  if (primary) return primary;
  return String(a.identifier ?? "").trim();
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

function parseMemoryProvenance(raw: unknown): MemoryProvenance {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const refs = p.references_memory_ids;
  return {
    ...(p.source_bus_id != null && String(p.source_bus_id).trim() !== ""
      ? { source_bus_id: String(p.source_bus_id) }
      : {}),
    ...(p.source_db_id != null && Number.isFinite(Number(p.source_db_id))
      ? { source_db_id: Number(p.source_db_id) }
      : {}),
    ...(p.source_external_message_id != null ? { source_external_message_id: String(p.source_external_message_id) } : {}),
    ...(p.source_contact_id != null ? { source_contact_id: String(p.source_contact_id) } : {}),
    ...(p.provenance_note != null ? { provenance_note: String(p.provenance_note) } : {}),
    ...(Array.isArray(refs) ? { references_memory_ids: refs.map((x) => Number(x)).filter((n) => Number.isInteger(n)) } : {}),
  };
}

export function createDirectCallTool(memoryEval?: MemoryEvalContext | null): AgentApiCallTool {
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
          const msg = validateUnknownParams(args, new Set(["bus_id", "limit", "offset", "from_timestamp", "to_timestamp", "from_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const limit = Math.min(Math.max(0, Number(a.limit) || 50), 200);
          const offset = Number(a.offset) || 0;
          const fromTs =
            a.from_timestamp != null && String(a.from_timestamp).trim() !== ""
              ? String(a.from_timestamp).trim()
              : undefined;
          const toTs =
            a.to_timestamp != null && String(a.to_timestamp).trim() !== "" ? String(a.to_timestamp).trim() : undefined;
          let fromId: number | undefined;
          if (a.from_id != null && String(a.from_id).trim() !== "") {
            const n = Number(a.from_id);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
              recipeStore.appendToolCall(name, args, "Invalid from_id");
              return finish("Error: from_id must be a positive integer (messages.id).");
            }
            fromId = n;
          }
          const filter =
            fromTs !== undefined || toTs !== undefined || fromId !== undefined
              ? { from_timestamp: fromTs, to_timestamp: toTs, from_id: fromId }
              : undefined;
          const sliced = getBusHistorySlice(busId, limit, offset, filter);
          const resultText = JSON.stringify(sliced);
          recipeStore.appendToolCall(name, args, `Returned ${sliced.length} messages`);
          return resultText;
        }

        case "bus.call": {
          const msg = validateUnknownParams(args, new Set(["bus_id", "timeout_ms"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const busId = telegramBusIdFromArgs(a.bus_id);
          if (!busId) {
            recipeStore.appendToolCall(name, args, "invalid bus_id");
            return finish("Error: bus_id must be a Telegram bus (telegram-<userId>).");
          }
          if (!isTelegramConnected()) {
            recipeStore.appendToolCall(name, args, "Telegram not connected");
            return finish("Error: Telegram not connected.");
          }
          const timeoutMs =
            a.timeout_ms != null && Number.isFinite(Number(a.timeout_ms)) ? Math.max(5_000, Number(a.timeout_ms)) : 120_000;
          try {
            const r = await gatewayTelegramVoip("/v1/voip/call", { bus_id: busId, timeout_ms: timeoutMs });
            const resultText = await r.text();
            recipeStore.appendToolCall(name, args, `status ${r.status}`);
            if (!r.ok && !resultText.startsWith("{")) {
              return finish(`Error: ${resultText || r.statusText}`);
            }
            return resultText;
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            recipeStore.appendToolCall(name, args, err);
            return finish(`Error: ${err}`);
          }
        }

        case "bus.pickup": {
          const msg = validateUnknownParams(args, new Set(["bus_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const busId = telegramBusIdFromArgs(a.bus_id);
          if (!busId) {
            recipeStore.appendToolCall(name, args, "invalid bus_id");
            return finish("Error: bus_id must be a Telegram bus (telegram-<userId>).");
          }
          if (!isTelegramConnected()) {
            recipeStore.appendToolCall(name, args, "Telegram not connected");
            return finish("Error: Telegram not connected.");
          }
          try {
            const r = await gatewayTelegramVoip("/v1/voip/pickup", { bus_id: busId });
            const resultText = await r.text();
            recipeStore.appendToolCall(name, args, `status ${r.status}`);
            if (!r.ok && !resultText.startsWith("{")) {
              return finish(`Error: ${resultText || r.statusText}`);
            }
            return resultText;
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            recipeStore.appendToolCall(name, args, err);
            return finish(`Error: ${err}`);
          }
        }

        case "bus.hangup": {
          const msg = validateUnknownParams(args, new Set(["bus_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          try {
            const body: Record<string, unknown> = {};
            if (a.bus_id != null && String(a.bus_id).trim() !== "") {
              body.bus_id = String(a.bus_id).trim();
            }
            const r = await gatewayTelegramVoip("/v1/voip/hangup", body);
            const resultText = await r.text();
            recipeStore.appendToolCall(name, args, `status ${r.status}`);
            if (!r.ok && !resultText.startsWith("{")) {
              return finish(`Error: ${resultText || r.statusText}`);
            }
            return resultText;
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            recipeStore.appendToolCall(name, args, err);
            return finish(`Error: ${err}`);
          }
        }

        case "bus.reject": {
          const msg = validateUnknownParams(args, new Set(["bus_id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const busId = telegramBusIdFromArgs(a.bus_id);
          if (!busId) {
            recipeStore.appendToolCall(name, args, "invalid bus_id");
            return finish("Error: bus_id must be a Telegram bus (telegram-<userId>).");
          }
          if (!isTelegramConnected()) {
            recipeStore.appendToolCall(name, args, "Telegram not connected");
            return finish("Error: Telegram not connected.");
          }
          try {
            const r = await gatewayTelegramVoip("/v1/voip/reject", { bus_id: busId });
            const resultText = await r.text();
            recipeStore.appendToolCall(name, args, `status ${r.status}`);
            if (!r.ok && !resultText.startsWith("{")) {
              return finish(`Error: ${resultText || r.statusText}`);
            }
            return resultText;
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            recipeStore.appendToolCall(name, args, err);
            return finish(`Error: ${err}`);
          }
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
            return finish("Error: Telegram not connected. Connect Telegram via the sidebar button.");
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
          const allowed = new Set(["is_successful"]);
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
          recipeStore.finalize(is_successful);
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

        case "contacts.list":
        case "contacts_list": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const list = contactList();
          recipeStore.appendToolCall(name, args, JSON.stringify(list));
          return JSON.stringify(list);
        }

        case "contacts.search":
        case "contacts_search": {
          const msg = validateUnknownParams(args, new Set(["query"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const query = String(a.query ?? "").trim();
          const searchList = contactSearch(query);
          recipeStore.appendToolCall(name, args, JSON.stringify(searchList));
          return JSON.stringify(searchList);
        }

        case "contacts.get":
        case "contacts_get": {
          const msg = validateUnknownParams(args, new Set(["id_or_identifier", "identifier"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const idOrIdentifier = contactLookupKey(a as Record<string, unknown>);
          const c = contactGet(idOrIdentifier);
          recipeStore.appendToolCall(name, args, c ? JSON.stringify(c) : "null");
          return c ? JSON.stringify(c) : "null";
        }

        case "contacts.create":
        case "contacts_create": {
          const allowed = new Set(["name", "identifier", "trust_level", "bus_ids", "notes"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const { name: n, identifier: id, trust_level: tl, bus_ids: bids, notes: notesVal } = a as Record<string, unknown>;
          const createdId = contactCreate({
            name: String(n ?? ""),
            identifier: String(id ?? ""),
            trust_level: tl as "root" | "normal" | undefined,
            bus_ids: Array.isArray(bids) ? bids.map(String) : undefined,
            notes: notesVal != null ? String(notesVal) : undefined,
          });
          recipeStore.appendToolCall(name, args, `Contact created: ${createdId}`);
          return `Contact created. id="${createdId}"`;
        }

        case "contacts.update":
        case "contacts_update": {
          const allowed = new Set(["id_or_identifier", "name", "identifier", "trust_level", "bus_ids", "notes"]);
          const msg = validateUnknownParams(args, allowed);
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const { name: n, identifier: id, trust_level: tl, bus_ids: bids, notes: notesVal } = a as Record<string, unknown>;
          contactUpdate(contactLookupKey(a as Record<string, unknown>), {
            name: n != null ? String(n) : undefined,
            identifier: id != null ? String(id) : undefined,
            trust_level: tl as "root" | "normal" | undefined,
            bus_ids: Array.isArray(bids) ? bids.map(String) : undefined,
            notes: notesVal != null ? String(notesVal) : undefined,
          });
          recipeStore.appendToolCall(name, args, "Contact updated");
          return "Contact updated.";
        }

        case "contacts.delete":
        case "contacts_delete": {
          const msg = validateUnknownParams(args, new Set(["id_or_identifier", "identifier"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const idOrIdentifier = contactLookupKey(a as Record<string, unknown>);
          contactDelete(idOrIdentifier);
          recipeStore.appendToolCall(name, args, "Contact deleted");
          return "Contact deleted.";
        }

        case "contacts.is_trusted":
        case "contacts_is_trusted": {
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

        case "soul.get":
        case "soul_get": {
          const msg = validateUnknownParams(args, new Set());
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const content = soulGet();
          recipeStore.appendToolCall(name, args, content);
          return JSON.stringify(content);
        }

        case "soul.set":
        case "soul_set": {
          const msg = validateUnknownParams(args, new Set(["content"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          soulSet(String(a.content ?? ""));
          recipeStore.appendToolCall(name, args, "Soul updated");
          return "Soul updated.";
        }

        case "memory.put": {
          if (!memoryEval) {
            recipeStore.appendToolCall(name, args, "no memory eval context");
            return finish("Error: memory tools require agent ts eval context.");
          }
          const msg = validateUnknownParams(args, new Set(["kind", "body", "tags", "key", "provenance"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const body = String(a.body ?? "");
          const prov = parseMemoryProvenance(a.provenance);
          const out = memoryPut(
            getHistoryDb(),
            {
              kind: a.kind != null ? String(a.kind) : undefined,
              body,
              tags: toStrArray(a.tags),
              key: a.key != null ? String(a.key) : undefined,
              provenance: prov,
            },
            memoryEval.buffers,
            { assistantDbId: memoryEval.assistantDbId, triggeringUserDbId: memoryEval.triggeringUserDbId }
          );
          if (!out.ok) {
            recipeStore.appendToolCall(name, args, out.error);
            return finish(`Error: ${out.error}`);
          }
          const resultText = JSON.stringify({ id: out.id });
          recipeStore.appendToolCall(name, args, resultText);
          return resultText;
        }

        case "memory.get": {
          if (!memoryEval) {
            recipeStore.appendToolCall(name, args, "no memory eval context");
            return finish("Error: memory tools require agent ts eval context.");
          }
          const msg = validateUnknownParams(args, new Set(["id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const id = Number(a.id);
          if (!Number.isFinite(id)) return finish("Error: id must be a number.");
          const row = memoryGet(getHistoryDb(), id, memoryEval.buffers);
          const resultText = JSON.stringify(row);
          recipeStore.appendToolCall(name, args, row ? "ok" : "null");
          return resultText;
        }

        case "memory.list": {
          if (!memoryEval) {
            recipeStore.appendToolCall(name, args, "no memory eval context");
            return finish("Error: memory tools require agent ts eval context.");
          }
          const msg = validateUnknownParams(args, new Set([
            "kind",
            "tags",
            "body_substring",
            "source_bus_id",
            "source_contact_id",
            "source_db_id",
            "from_timestamp",
            "to_timestamp",
            "limit",
            "offset",
          ]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const f: MemoryListFilter = {};
          if (a.kind != null && String(a.kind).trim() !== "") f.kind = String(a.kind);
          if (a.tags != null) f.tags = toStrArray(a.tags);
          if (a.body_substring != null) f.body_substring = String(a.body_substring);
          if (a.source_bus_id != null) f.source_bus_id = String(a.source_bus_id);
          if (a.source_contact_id != null) f.source_contact_id = String(a.source_contact_id);
          if (a.source_db_id != null && a.source_db_id !== "") f.source_db_id = Number(a.source_db_id);
          if (a.from_timestamp != null) f.from_timestamp = String(a.from_timestamp);
          if (a.to_timestamp != null) f.to_timestamp = String(a.to_timestamp);
          if (a.limit != null) f.limit = Number(a.limit);
          if (a.offset != null) f.offset = Number(a.offset);
          const rows = memoryList(getHistoryDb(), f, memoryEval.buffers);
          const resultText = JSON.stringify(rows);
          recipeStore.appendToolCall(name, args, `count ${rows.length}`);
          return resultText;
        }

        case "memory.delete": {
          if (!memoryEval) {
            recipeStore.appendToolCall(name, args, "no memory eval context");
            return finish("Error: memory tools require agent ts eval context.");
          }
          const msg = validateUnknownParams(args, new Set(["id"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const id = Number(a.id);
          if (!Number.isFinite(id)) return finish("Error: id must be a number.");
          const ok = memoryDelete(getHistoryDb(), id, memoryEval.buffers);
          recipeStore.appendToolCall(name, args, ok ? "deleted" : "miss");
          return ok ? `Deleted memory ${id}.` : `No memory ${id}.`;
        }

        case "memory.find": {
          if (!memoryEval) {
            recipeStore.appendToolCall(name, args, "no memory eval context");
            return finish("Error: memory tools require agent ts eval context.");
          }
          const msg = validateUnknownParams(args, new Set(["query", "mode", "limit"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          const query = String(a.query ?? "");
          if (!query.trim()) return finish("Error: query is required.");
          const mode = a.mode === "like" ? "like" : "fts";
          const limit = a.limit != null ? Number(a.limit) : undefined;
          const rows = memoryFind(getHistoryDb(), { query, mode, limit }, memoryEval.buffers);
          const resultText = JSON.stringify(rows);
          recipeStore.appendToolCall(name, args, `count ${rows.length}`);
          return resultText;
        }

        case "memory.set_help": {
          if (!memoryEval) {
            recipeStore.appendToolCall(name, args, "no memory eval context");
            return finish("Error: memory tools require agent ts eval context.");
          }
          const msg = validateUnknownParams(args, new Set(["text"]));
          if (msg) {
            recipeStore.appendToolCall(name, args, msg);
            return finish(msg);
          }
          setMemoryHelpText(getHistoryDb(), String(a.text ?? ""));
          recipeStore.appendToolCall(name, args, "help set");
          return "Memory help text updated.";
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
          const setupMode = getDirectToolsSetupMode();
          if (setupMode) {
            return [
              "VM started. Setup checklist:",
              "1. Check if /mnt/shared is mounted in the VM.",
              "2. If mounted, ensure it is mounted on boot (e.g. /etc/fstab or systemd mount unit).",
              "3. If mounted on boot, ensure /mnt/shared/yaaia-vm-agent is configured to launch at system boot after mounts (e.g. systemd service).",
              "See VM_SETUP.md for details.",
            ].join("\n");
          }
          if (isVmEvalConnected()) {
            return "VM already powered on and agent connected. Continuing.";
          }
          throw new VmPowerOnAbortError();
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
            recipeStore.appendToolCall(name, args, "Removed");
            return finish(
              "Error: Host fs tools removed. Use vm-bash blocks for file operations in /mnt/shared (host shared folder)."
            );
          }
          if (name.startsWith("mail.")) {
            return await handleMailTool(name, a, finish);
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

}
