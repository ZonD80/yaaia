import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServerConfig } from "./config.js";
import {
  connectChromeMcp,
  disconnectChromeMcp,
  listChromeTools,
  callChromeTool,
  isScreenshotTool,
  isPageChangingTool,
  extractScreenshotFromResult,
  takeScreenshotForRecipe,
  type ChromeTool,
} from "./chrome-client.js";
import { waitForUserReply } from "../ask-user-bridge.js";
import { secretsList, secretsGet, secretsSet, secretsDelete } from "../secrets-store.js";
import {
  agentConfigList,
  agentConfigSet,
  agentConfigDelete,
} from "../agent-config-store.js";
import * as recipeStore from "../recipe-store.js";
import {
  connectKbMcp,
  disconnectKbMcp,
  listKbTools,
  callKbTool,
  runQmdCli,
  kbWrite,
  kbReplace,
  kbDelete,
  kbList,
  kbCollectionAdd,
  kbCollectionList,
  kbCollectionRemove,
  kbEnsureCollection,
  buildKbPathFromCollection,
  type KbTool,
} from "./kb-client.js";
import {
  mailConnect,
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
} from "../mail-client.js";
import {
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
  isCaldavConnected,
  startGoogleOAuthBrowserServer,
} from "../caldav-client.js";
import { removeEventTaskMapping } from "../caldav-event-tasks-store.js";
import { addSchedule, listSchedules, getStartupTask, deleteSchedule } from "../schedule-store.js";
import {
  listBuses,
  setBusProperties,
  deleteBus,
  appendToBusHistory,
  ensureBus,
  getBusHistory,
  getBusHistorySlice,
  getBusTrustLevel,
  ROOT_BUS_ID,
} from "../message-bus-store.js";
import { removeMessagesFromBusHistoryByMailUids, removeMessagesFromBusHistoryByEventUids, loadBusProperties, saveBusProperties } from "../history-store.js";

const BROWSER_URL = "http://127.0.0.1:9222";

/** Parse IMAP range (e.g. "123", "123,124", "123:125") into UID list. */
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

const BUS_ID_PARAM = z
  .string()
  .describe("Message bus id (e.g. root, telegram-123). Mandatory for every tool.");

const CLARIFICATION_PARAM = z
  .string()
  .describe("Why you are using this tool and what outcome you expect. Mandatory.");

const ASSESSMENT_PARAM = z
  .string()
  .describe("Assessment of previous tool call result or user instructions. Mandatory: on first call assess user request; on subsequent calls assess last tool result.");

function toolResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function logToolCall(toolName: string, args: unknown): void {
  const a = args as Record<string, unknown> | undefined;
  const { assessment: _a, clarification: _c, ...rest } = (a ?? {}) as Record<string, unknown>;
  console.log("[YAAIA MCP] Tool call:", toolName, JSON.stringify(rest));
}

function logClarification(toolName: string, args: unknown): void {
  const a = args as Record<string, unknown> | undefined;
  const c = a?.clarification;
  if (typeof c === "string" && c.trim()) {
    console.log(`[YAAIA MCP] Tool ${toolName} clarification:`, c.trim());
  }
}

function logAssessment(toolName: string, args: unknown): void {
  const a = args as Record<string, unknown> | undefined;
  const v = a?.assessment;
  if (typeof v === "string" && v.trim()) {
    console.log(`[YAAIA MCP] Tool ${toolName} assessment:`, v.trim());
  }
}

function validateUnknownParams(
  toolName: string,
  args: unknown,
  allowedKeys: Set<string>
): string | null {
  const a = args as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  const unknown = Object.keys(a).filter((k) => !allowedKeys.has(k));
  if (unknown.length === 0) return null;
  return `${toolName} does not accept: ${unknown.join(", ")}`;
}

function stripBusIdAssessmentClarification(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  delete out.bus_id;
  delete out.assessment;
  delete out.clarification;
  return out;
}

/** Apply defaults to prevent Chrome from stealing focus when opening/navigating pages. */
function applyDefaultsNoFocusSteal(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...args };
  if (name === "new_page" && out.background === undefined) {
    out.background = true;
  }
  if (name === "select_page" && out.bringToFront === undefined) {
    out.bringToFront = false;
  }
  return out;
}

function contentToText(content: { type: string; text?: string; resource?: { text?: string } }[]): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "resource" && item.resource && typeof item.resource.text === "string") {
      // qmd get/multi_get return document body in resource.text
      parts.push(item.resource.text);
    }
  }
  return parts.join("\n").trim() || "(no output)";
}

type JsonSchemaProp = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProp;
  default?: unknown;
};

function jsonSchemaPropToZod(prop: JsonSchemaProp, required: boolean): z.ZodTypeAny {
  const desc = typeof prop.description === "string" ? prop.description : undefined;
  let base: z.ZodTypeAny;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const values = prop.enum.map(String);
    base = z.enum(values as [string, ...string[]]);
  } else {
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    switch (type) {
      case "string":
        base = z.string();
        break;
      case "number":
      case "integer":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array":
        base = z.array(z.any());
        break;
      case "object":
        base = z.record(z.any());
        break;
      default:
        base = z.any();
    }
  }
  const withDesc = desc ? base.describe(desc) : base;
  return required ? withDesc : withDesc.optional();
}

function buildChromeToolInputSchema(
  baseSchema: ChromeTool["inputSchema"],
  required: string[]
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const props = baseSchema?.properties ?? {};
  const baseRequired = new Set(baseSchema?.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {
    bus_id: BUS_ID_PARAM,
    assessment: ASSESSMENT_PARAM,
    clarification: CLARIFICATION_PARAM,
  };
  for (const [key, prop] of Object.entries(props)) {
    if (key === "bus_id" || key === "assessment" || key === "clarification") continue;
    const p = prop as JsonSchemaProp;
    shape[key] = jsonSchemaPropToZod(p ?? {}, baseRequired.has(key));
  }
  return z.object(shape);
}

function buildKbToolInputSchema(
  baseSchema: KbTool["inputSchema"],
  required: string[]
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const props = baseSchema?.properties ?? {};
  const baseRequired = new Set(baseSchema?.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {
    bus_id: BUS_ID_PARAM,
    assessment: ASSESSMENT_PARAM,
    clarification: CLARIFICATION_PARAM,
  };
  for (const [key, prop] of Object.entries(props)) {
    if (key === "bus_id" || key === "assessment" || key === "clarification") continue;
    const p = prop as JsonSchemaProp;
    shape[key] = jsonSchemaPropToZod(p ?? {}, baseRequired.has(key));
  }
  return z.object(shape);
}

async function createMcpServer(config: McpServerConfig): Promise<McpServer> {
  config.onStartupProgress?.("Connecting Chrome MCP...");
  await connectChromeMcp(BROWSER_URL);
  config.onStartupProgress?.("Chrome ready");

  config.onStartupProgress?.("Connecting Knowledge Base...");
  await connectKbMcp((line) => config.onStartupProgress?.(line));
  config.onStartupProgress?.("KB ready");

  const chromeTools = await listChromeTools();
  const kbTools = await listKbTools();

  const server = new McpServer(
    { name: "yaaia", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  for (const tool of chromeTools) {
    const name = tool.name;
    const baseSchema = tool.inputSchema ?? { type: "object", properties: {}, required: [] };
    const required = [...(baseSchema.required ?? [])];
    if (!required.includes("bus_id")) required.push("bus_id");
    if (!required.includes("assessment")) required.push("assessment");
    if (!required.includes("clarification")) required.push("clarification");

    server.registerTool(
      name,
      {
        description: (tool.description ?? `Chrome DevTools: ${name}`) + " Always provide bus_id, assessment and clarification.",
        inputSchema: buildChromeToolInputSchema(baseSchema, required),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        logToolCall(name, args);
        logClarification(name, args);
        logAssessment(name, args);
        const forwardArgs = applyDefaultsNoFocusSteal(
          name,
          stripBusIdAssessmentClarification(a)
        );
        try {
          const result = await callChromeTool(name, forwardArgs);
          const text = contentToText(result.content);
          let screenshotBase64 = extractScreenshotFromResult(result);
          if (!screenshotBase64 && !result.isError && isPageChangingTool(name) && !isScreenshotTool(name)) {
            screenshotBase64 = await takeScreenshotForRecipe();
          }
          const recipeExtra = screenshotBase64 ? { screenshotBase64 } : undefined;
          recipeStore.appendToolCall(name, args, text, recipeExtra);
          if (result.isError) {
            return toolResult(`Error: ${text}`);
          }
          if (name === "new_page") {
            setTimeout(() => config.onRefocusMainWindow?.(), 150);
          }
          return toolResult(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recipeStore.appendToolCall(name, args, msg);
          return toolResult(`Error: ${msg}`);
        }
      }
    );
  }

  for (const tool of kbTools) {
    const qmdName = tool.name;
    const name = `kb__qmd_${qmdName.replace(/^qmd_/, "")}`;
    const baseSchema = tool.inputSchema ?? { type: "object", properties: {}, required: [] };
    const required = [...(baseSchema.required ?? [])];
    if (!required.includes("bus_id")) required.push("bus_id");
    if (!required.includes("assessment")) required.push("assessment");
    if (!required.includes("clarification")) required.push("clarification");

    server.registerTool(
      name,
      {
        description: (tool.description ?? `KB/QMD: ${qmdName}`) + " Always provide bus_id, assessment and clarification.",
        inputSchema: buildKbToolInputSchema(baseSchema, required),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        logToolCall(name, args);
        logClarification(name, args);
        logAssessment(name, args);
        let forwardArgs = stripBusIdAssessmentClarification(a);
        if (qmdName === "get" && typeof forwardArgs.file === "string") {
          const f = forwardArgs.file.trim();
          if (f && !f.startsWith("qmd://") && !f.startsWith("#")) {
            forwardArgs = { ...forwardArgs, file: `qmd://${f.replace(/^\/+/, "")}` };
          }
        }
        if (qmdName === "multi_get" && typeof forwardArgs.pattern === "string") {
          const p = forwardArgs.pattern.trim();
          // QMD matchFilesByGlob matches against virtual_path (qmd://collection/path). Patterns like
          // "lessons_learned/*.md" must be prefixed with qmd:// to match.
          if (p && !p.startsWith("qmd://") && !p.includes(",")) {
            forwardArgs = { ...forwardArgs, pattern: `qmd://${p.replace(/^\/+/, "")}` };
          }
        }
        try {
          const result = await callKbTool(qmdName, forwardArgs);
          const text = contentToText(result.content);
          recipeStore.appendToolCall(name, args, text);
          return toolResult(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recipeStore.appendToolCall(name, args, msg);
          return toolResult(`Error: ${msg}`);
        }
      }
    );
  }

  const KB_BASE = new Set(["bus_id", "assessment", "clarification"]);

  server.registerTool(
    "kb__write",
    {
      description: "Create or overwrite a .md or .qmd file in the knowledge base. Requires collection (created if missing). Path is relative to collection root.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        collection: z.string().describe("Collection name (e.g. lessons_learned, identity). Created if missing."),
        path: z.string().describe("Path relative to collection e.g. file.md or subfolder/note.md"),
        content: z.string().describe("File content"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("kb__write", args);
      const allowed = new Set([...KB_BASE, "collection", "path", "content"]);
      const unknownMsg = validateUnknownParams("kb__write", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__write", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { collection, path: p, content } = args as { collection: string; path: string; content: string };
      logClarification("kb__write", args);
      logAssessment("kb__write", args);
      try {
        await kbEnsureCollection(collection);
        const fullPath = buildKbPathFromCollection(collection, p);
        kbWrite(fullPath, content);
        await runQmdCli(["update"]);
        await runQmdCli(["embed"]);
        recipeStore.appendToolCall("kb__write", args, "Written.");
        return toolResult(`Written ${collection}/${p}. Index updated.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__write", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__delete",
    {
      description: "Delete a .md or .qmd file from the knowledge base. Requires collection. Path is relative to collection root.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        collection: z.string().describe("Collection name (e.g. lessons_learned, identity)"),
        path: z.string().describe("Path relative to collection e.g. file.md or subfolder/note.md"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("kb__delete", args);
      const allowed = new Set([...KB_BASE, "collection", "path"]);
      const unknownMsg = validateUnknownParams("kb__delete", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { collection, path: p } = args as { collection: string; path: string };
      logClarification("kb__delete", args);
      logAssessment("kb__delete", args);
      try {
        const fullPath = buildKbPathFromCollection(collection, p);
        kbDelete(fullPath);
        await runQmdCli(["update"]);
        await runQmdCli(["embed"]);
        recipeStore.appendToolCall("kb__delete", args, "Deleted.");
        return toolResult(`Deleted ${collection}/${p}. Index updated.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__delete", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__replace",
    {
      description: "Replace a range of lines (from_line to to_line inclusive, 0-based) in a .md or .qmd file. to_line=-1 means end of file. For append: from_line=line count (one past last), to_line=-1.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        collection: z.string().describe("Collection name (e.g. lessons_learned, identity)"),
        path: z.string().describe("Path relative to collection e.g. file.md or subfolder/note.md"),
        from_line: z.number().describe("0-based start line (inclusive)"),
        to_line: z.number().describe("0-based end line (inclusive). -1 = end of file."),
        content: z.string().describe("Replacement content (newline-separated for multiple lines)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("kb__replace", args);
      const allowed = new Set([...KB_BASE, "collection", "path", "from_line", "to_line", "content"]);
      const unknownMsg = validateUnknownParams("kb__replace", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__replace", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { collection, path: p, from_line, to_line, content } = args as { collection: string; path: string; from_line: number; to_line: number; content: string };
      logClarification("kb__replace", args);
      logAssessment("kb__replace", args);
      try {
        const fullPath = buildKbPathFromCollection(collection, p);
        kbReplace(fullPath, from_line, to_line, content);
        await runQmdCli(["update"]);
        await runQmdCli(["embed"]);
        recipeStore.appendToolCall("kb__replace", args, "Replaced.");
        return toolResult(`Replaced lines ${from_line}-${to_line} in ${collection}/${p}. Index updated.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__replace", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__list",
    {
      description: "List files and folders in a collection. Path is relative to collection root.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        collection: z.string().describe("Collection name (e.g. lessons_learned, identity)"),
        path: z.string().optional().default("").describe("Path relative to collection, empty for root"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("kb__list", args);
      const allowed = new Set([...KB_BASE, "collection", "path"]);
      const unknownMsg = validateUnknownParams("kb__list", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { collection, path: p = "" } = args as { collection: string; path?: string };
      logClarification("kb__list", args);
      logAssessment("kb__list", args);
      try {
        const fullPath = buildKbPathFromCollection(collection, p || ".");
        const list = kbList(fullPath, true);
        const text = list.length ? list.join("\n") : "(empty)";
        recipeStore.appendToolCall("kb__list", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__list", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__qmd_collection_add",
    {
      description: "Add a collection to the KB index. Creates folder if needed. subpath is relative to ~/yaaia/kb.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        name: z.string().describe("Collection name"),
        subpath: z.string().optional().describe("Path under ~/yaaia/kb (default: name)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("kb__qmd_collection_add", args);
      const allowed = new Set([...KB_BASE, "name", "subpath"]);
      const unknownMsg = validateUnknownParams("kb__qmd_collection_add", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__qmd_collection_add", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { name, subpath } = args as { name: string; subpath?: string };
      logClarification("kb__qmd_collection_add", args);
      logAssessment("kb__qmd_collection_add", args);
      try {
        const result = await kbCollectionAdd(name, subpath);
        recipeStore.appendToolCall("kb__qmd_collection_add", args, result);
        return toolResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__qmd_collection_add", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__qmd_collection_list",
    {
      description: "List all KB collections.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("kb__qmd_collection_list", args);
      const unknownMsg = validateUnknownParams("kb__qmd_collection_list", args, KB_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__qmd_collection_list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("kb__qmd_collection_list", args);
      logAssessment("kb__qmd_collection_list", args);
      try {
        const result = await kbCollectionList();
        recipeStore.appendToolCall("kb__qmd_collection_list", args, result);
        return toolResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__qmd_collection_list", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__qmd_collection_remove",
    {
      description: "Remove a collection from the KB index.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        name: z.string().describe("Collection name"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("kb__qmd_collection_remove", args);
      const allowed = new Set([...KB_BASE, "name"]);
      const unknownMsg = validateUnknownParams("kb__qmd_collection_remove", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__qmd_collection_remove", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { name } = args as { name: string };
      logClarification("kb__qmd_collection_remove", args);
      logAssessment("kb__qmd_collection_remove", args);
      try {
        const result = await kbCollectionRemove(name);
        recipeStore.appendToolCall("kb__qmd_collection_remove", args, result);
        return toolResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__qmd_collection_remove", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__qmd_update",
    {
      description: "Run qmd update to re-index the knowledge base.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("kb__qmd_update", args);
      const unknownMsg = validateUnknownParams("kb__qmd_update", args, KB_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__qmd_update", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("kb__qmd_update", args);
      logAssessment("kb__qmd_update", args);
      try {
        await runQmdCli(["update"]);
        recipeStore.appendToolCall("kb__qmd_update", args, "Updated.");
        return toolResult("Index updated.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__qmd_update", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "kb__qmd_embed",
    {
      description: "Run qmd embed to update vector embeddings.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("kb__qmd_embed", args);
      const unknownMsg = validateUnknownParams("kb__qmd_embed", args, KB_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("kb__qmd_embed", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("kb__qmd_embed", args);
      logAssessment("kb__qmd_embed", args);
      try {
        await runQmdCli(["embed"]);
        recipeStore.appendToolCall("kb__qmd_embed", args, "Embedded.");
        return toolResult("Embeddings updated.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("kb__qmd_embed", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to a bus. STRICTLY REQUIRED: Use this for every reply. Plain text output is forbidden—only send_message delivers messages. bus_id: root for desktop chat, telegram-{peer_id} for Telegram. CRITICAL: If your message asks a question, approval, confirmation, or choice and you need the reply to proceed—you MUST set wait_for_answer=true. Without it you never receive the reply. wait_for_answer=true blocks until user replies (60s timeout).",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        content: z.string().describe("Message content to send"),
        wait_for_answer: z.boolean().optional().default(false).describe("REQUIRED when asking a question/approval/confirmation—set true or you never get the reply. Blocks until user replies (60s)."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { bus_id?: string; content?: string; wait_for_answer?: boolean };
      logToolCall("send_message", args);
      const unknownMsg = validateUnknownParams("send_message", args, new Set(["bus_id", "content", "wait_for_answer", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("send_message", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const busId = String(a.bus_id ?? "").trim();
      const content = String(a.content ?? "").trim().replace(/\\n/g, "\n");
      const waitForAnswer = a.wait_for_answer === true;
      if (!busId) {
        recipeStore.appendToolCall("send_message", args, "bus_id is required");
        return toolResult("Error: bus_id is required");
      }
      logClarification("send_message", args);
      logAssessment("send_message", args);
      if (waitForAnswer && busId !== ROOT_BUS_ID && !busId.startsWith("telegram-")) {
        recipeStore.appendToolCall("send_message", args, "wait_for_answer only supports root or telegram-* buses");
        return toolResult("Error: wait_for_answer only supports bus_id=root or telegram-{peer_id}.");
      }
      ensureBus(busId);
      appendToBusHistory(busId, { role: "assistant", content });
      const displayText = `[${busId}] ${content}`;
      config.onSendMessage?.(busId);
      if (busId === ROOT_BUS_ID) {
        config.onSendMessageToRoot?.(content);
        if (!waitForAnswer) recipeStore.setPendingReportFromSendMessage(content);
      } else if (busId.startsWith("telegram-")) {
        config.onSendMessageToRoot?.(`[${busId}] ${content}`);
        try {
          await config.onSendMessageToTelegram?.(busId, content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recipeStore.appendToolCall("send_message", args, msg);
          return toolResult(`Error sending to ${busId}: ${msg}`);
        }
      }
      if (waitForAnswer) {
        if (busId === ROOT_BUS_ID) {
          config.onAskUserRequest?.({ clarification: content, assessment: "", attempt: 0 });
        }
        const reply = await waitForUserReply({
          timeoutMs: 60_000,
          onTimeout: config.onAskUserTimeout,
          busId: busId !== ROOT_BUS_ID ? busId : undefined,
        });
        recipeStore.appendToolCall("send_message", args, reply);
        return toolResult(reply);
      }
      if (busId === ROOT_BUS_ID) {
        recipeStore.appendToolCall("send_message", args, displayText);
        return toolResult(displayText);
      }
      recipeStore.appendToolCall("send_message", args, displayText);
      return toolResult(displayText);
    }
  );

  server.registerTool(
    "list_buses",
    {
      description: "List all known message buses with their descriptions and connection status (is_connected).",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("list_buses", args);
      const unknownMsg = validateUnknownParams("list_buses", args, new Set(["bus_id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("list_buses", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("list_buses", args);
      logAssessment("list_buses", args);
      const buses = listBuses();
      const resultText = JSON.stringify(buses);
      recipeStore.appendToolCall("list_buses", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "get_datetime",
    {
      description: "Return the current date and time in UTC (ISO 8601).",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    (args) => {
      logToolCall("get_datetime", args);
      const unknownMsg = validateUnknownParams("get_datetime", args, new Set(["bus_id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("get_datetime", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("get_datetime", args);
      logAssessment("get_datetime", args);
      const resultText = new Date().toISOString();
      recipeStore.appendToolCall("get_datetime", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "get_bus_history",
    {
      description:
        "Get conversation history for a bus from kb/history (KB storage). Use limit and offset for slices. offset=0, limit=N = last N; offset>0 = from start; offset<0 = from end. Call when you need more context.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        limit: z.number().optional().default(50).describe("Max messages to return (default 50)."),
        offset: z.number().optional().default(0).describe("Skip first N (0) or from end if negative (e.g. -20 for last 20)."),
      }),
    },
    async (args) => {
      const a = args as { bus_id?: string; limit?: number; offset?: number };
      logToolCall("get_bus_history", args);
      const unknownMsg = validateUnknownParams("get_bus_history", args, new Set(["bus_id", "assessment", "clarification", "limit", "offset"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("get_bus_history", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const busId = String(a.bus_id ?? "").trim();
      const limit = Math.min(Math.max(0, Number(a.limit) || 50), 200);
      const offset = Number(a.offset) || 0;
      if (!busId) {
        recipeStore.appendToolCall("get_bus_history", args, "bus_id is required");
        return toolResult("Error: bus_id is required");
      }
      logClarification("get_bus_history", args);
      logAssessment("get_bus_history", args);
      const sliced = getBusHistorySlice(busId, limit, offset);
      const resultText = JSON.stringify(sliced);
      recipeStore.appendToolCall("get_bus_history", args, `Returned ${sliced.length} messages`);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "telegram_connect",
    {
      description:
        "Connect to Telegram as a user. Use when you want to receive/send messages via Telegram. Requires phone (mandatory). On success returns bus listings. Root is the unified context; use get_bus_history(bus_id, ..., limit, offset) for slices when you need more context.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        phone: z.string().describe("Phone number in international format (e.g. +1234567890). Mandatory."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { phone?: string };
      logToolCall("telegram_connect", args);
      const unknownMsg = validateUnknownParams("telegram_connect", args, new Set(["bus_id", "phone", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("telegram_connect", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const phone = String(a.phone ?? "").trim();
      if (!phone) {
        recipeStore.appendToolCall("telegram_connect", args, "phone is required");
        return toolResult("Error: phone is required.");
      }
      logClarification("telegram_connect", args);
      logAssessment("telegram_connect", args);
      try {
        const result = await config.onTelegramConnect?.(phone);
        if (!result) {
          recipeStore.appendToolCall("telegram_connect", args, "Telegram connect not available");
          return toolResult("Error: Telegram connect not available.");
        }
        if (!result.ok) {
          recipeStore.appendToolCall("telegram_connect", args, result.error ?? "Unknown error");
          return toolResult(`Error: ${result.error ?? "Unknown error"}`);
        }
        const buses = result.buses ?? [];
        const instruction = result.instruction ?? "If you need conversation history for a bus, call get_bus_history(bus_id, assessment, clarification, limit).";
        const missed = result.missedMessages ?? [];
        let out: string;
        if (missed.length === 0) {
          out = `Connected. Buses: ${JSON.stringify(buses)}. ${instruction}`;
        } else {
          const missedStr = missed.map((m) => `[${m.bus_id}] ${m.user_name}: ${m.content}`).join("\n");
          out = `Connected. Buses: ${JSON.stringify(buses)}. Missed messages (appended to buses):\n${missedStr}\n\n${instruction}`;
        }
        recipeStore.appendToolCall("telegram_connect", args, "Connected");
        return toolResult(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("telegram_connect", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "telegram_search",
    {
      description:
        "Resolve a Telegram username to bus_id. Use when you need to message a user/channel by username (e.g. @durov or durov). Requires Telegram to be connected. Returns bus_id for send_message.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        username: z.string().describe("Telegram username with or without @ (e.g. durov or @durov)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { username?: string };
      logToolCall("telegram_search", args);
      const unknownMsg = validateUnknownParams("telegram_search", args, new Set(["bus_id", "username", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("telegram_search", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const username = String(a.username ?? "").trim();
      if (!username) {
        recipeStore.appendToolCall("telegram_search", args, "username is required");
        return toolResult("Error: username is required (e.g. durov or @durov).");
      }
      logClarification("telegram_search", args);
      logAssessment("telegram_search", args);
      try {
        const result = await config.onTelegramSearch?.(username);
        if (!result) {
          recipeStore.appendToolCall("telegram_search", args, "Telegram search not available");
          return toolResult("Error: Telegram not connected. Call telegram_connect first.");
        }
        const out = JSON.stringify(result);
        recipeStore.appendToolCall("telegram_search", args, out);
        return toolResult(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("telegram_search", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "set_mb_properties",
    {
      description: "Set or update properties for a message bus (description, trust_level, is_banned). trust_level: normal (default) or root. is_banned: when true, messages to this bus get auto-reply 'I don't want to talk with you' without history. Root cannot be banned.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        mb_id: z.string().describe("Message bus id (same as bus_id)"),
        description: z.string().optional().describe("Description for the bus"),
        trust_level: z.enum(["normal", "root"]).optional().describe("Trust level: normal (default) or root. Root = wrap messages in session tag."),
        is_banned: z.boolean().optional().describe("When true, auto-reply 'I don't want to talk with you' to messages. Root cannot be banned."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { bus_id?: string; mb_id?: string; description?: string; trust_level?: "normal" | "root"; is_banned?: boolean };
      logToolCall("set_mb_properties", args);
      const unknownMsg = validateUnknownParams("set_mb_properties", args, new Set(["bus_id", "mb_id", "description", "trust_level", "is_banned", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("set_mb_properties", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const mbId = String(a.mb_id ?? a.bus_id ?? "").trim();
      if (!mbId) {
        recipeStore.appendToolCall("set_mb_properties", args, "mb_id is required");
        return toolResult("Error: mb_id is required");
      }
      if (a.is_banned === true && mbId === ROOT_BUS_ID) {
        recipeStore.appendToolCall("set_mb_properties", args, "Root bus cannot be banned");
        return toolResult("Error: Root bus cannot be banned.");
      }
      logClarification("set_mb_properties", args);
      logAssessment("set_mb_properties", args);
      try {
        const props: { description?: string; trust_level?: "normal" | "root"; is_banned?: boolean } = {};
        if (a.description !== undefined) props.description = String(a.description).trim();
        if (a.trust_level !== undefined) props.trust_level = a.trust_level;
        if (a.is_banned !== undefined) props.is_banned = a.is_banned;
        setBusProperties(mbId, props);
        recipeStore.appendToolCall("set_mb_properties", args, `Properties set for ${mbId}`);
        return toolResult(`Properties set for ${mbId}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("set_mb_properties", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "delete_bus",
    {
      description: "Delete a message bus and its history (kb/history). Root bus cannot be deleted.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        mb_id: z.string().describe("Message bus id to delete"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { mb_id?: string };
      logToolCall("delete_bus", args);
      const unknownMsg = validateUnknownParams("delete_bus", args, new Set(["bus_id", "mb_id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("delete_bus", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const mbId = String(a.mb_id ?? "").trim();
      if (!mbId) {
        recipeStore.appendToolCall("delete_bus", args, "mb_id is required");
        return toolResult("Error: mb_id is required");
      }
      logClarification("delete_bus", args);
      logAssessment("delete_bus", args);
      try {
        await deleteBus(mbId);
        recipeStore.appendToolCall("delete_bus", args, `Bus ${mbId} deleted`);
        return toolResult(`Bus ${mbId} deleted.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("delete_bus", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "schedule_task",
    {
      description: "Schedule a one-time task to run at a specific time (RFC 3339, e.g. 2025-03-10T14:30:00Z). When the time arrives, the task is injected as a user message at root. For recurring tasks, schedule a new one after completing the current.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        at: z.string().describe("When to run the task (RFC 3339 datetime, e.g. 2025-03-10T14:30:00Z)"),
        title: z.string().describe("Short task title"),
        instructions: z.string().describe("What the agent should do when the task runs"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { bus_id?: string; at?: string; title?: string; instructions?: string };
      logToolCall("schedule_task", args);
      const unknownMsg = validateUnknownParams("schedule_task", args, new Set(["bus_id", "at", "title", "instructions", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("schedule_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const at = String(a.at ?? "").trim();
      const title = String(a.title ?? "").trim();
      const instructions = String(a.instructions ?? "").trim();
      if (!at) {
        recipeStore.appendToolCall("schedule_task", args, "at is required");
        return toolResult("Error: at is required (RFC 3339 datetime)");
      }
      if (!title) {
        recipeStore.appendToolCall("schedule_task", args, "title is required");
        return toolResult("Error: title is required");
      }
      const parsed = new Date(at);
      if (isNaN(parsed.getTime())) {
        recipeStore.appendToolCall("schedule_task", args, "at must be valid RFC 3339 datetime");
        return toolResult("Error: at must be valid RFC 3339 datetime (e.g. 2025-03-10T14:30:00Z)");
      }
      if (parsed.getTime() <= Date.now()) {
        recipeStore.appendToolCall("schedule_task", args, "at must be in the future");
        return toolResult("Error: at must be in the future");
      }
      logClarification("schedule_task", args);
      logAssessment("schedule_task", args);
      try {
        const entry = addSchedule(at, title, instructions);
        recipeStore.appendToolCall("schedule_task", args, `Scheduled: ${title} at ${at}`);
        return toolResult(`Scheduled task "${title}" for ${at} (id: ${entry.id}).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("schedule_task", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List all tasks: the startup task (runs on app start) and scheduled tasks (run at specified times). Returns JSON with startup_task and scheduled.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("list_tasks", args);
      const unknownMsg = validateUnknownParams("list_tasks", args, new Set(["bus_id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("list_tasks", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("list_tasks", args);
      logAssessment("list_tasks", args);
      const startup = getStartupTask();
      const scheduled = listSchedules();
      const result = JSON.stringify({ startup_task: startup, scheduled }, null, 2);
      recipeStore.appendToolCall("list_tasks", args, result);
      return toolResult(result);
    }
  );

  server.registerTool(
    "delete_scheduled_task",
    {
      description: "Delete a scheduled task by id. Use list_tasks to get task ids.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        task_id: z.string().describe("Task id from list_tasks (scheduled[].id)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const a = args as { task_id?: string };
      logToolCall("delete_scheduled_task", args);
      const unknownMsg = validateUnknownParams("delete_scheduled_task", args, new Set(["bus_id", "task_id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("delete_scheduled_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const taskId = String(a.task_id ?? "").trim();
      if (!taskId) {
        recipeStore.appendToolCall("delete_scheduled_task", args, "task_id is required");
        return toolResult("Error: task_id is required");
      }
      logClarification("delete_scheduled_task", args);
      logAssessment("delete_scheduled_task", args);
      const deleted = deleteSchedule(taskId);
      if (deleted) {
        recipeStore.appendToolCall("delete_scheduled_task", args, `Deleted task ${taskId}`);
        return toolResult(`Deleted scheduled task ${taskId}.`);
      }
      recipeStore.appendToolCall("delete_scheduled_task", args, "Task not found");
      return toolResult(`Error: Task ${taskId} not found.`);
    }
  );

  server.registerTool(
    "start_task",
    {
      description: "Start a task. Call at the beginning of a new task.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        summary: z.string().describe("Short task summary/name"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("start_task", args);
      const unknownMsg = validateUnknownParams("start_task", args, new Set(["bus_id", "summary", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("start_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const summary = typeof (args as { summary?: string }).summary === "string" ? (args as { summary: string }).summary : "";
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      const busId = String((args as { bus_id?: string }).bus_id ?? "").trim();
      logClarification("start_task", args);
      logAssessment("start_task", args);
      recipeStore.initFromStartTask(summary, assessment, busId);
      config.onStartTask?.({ summary });
      return toolResult("Task started.");
    }
  );

  server.registerTool(
    "finalize_task",
    {
      description: "Mandatory when task is complete. Call before ending. is_successful (true/false) is mandatory. After calling, you may send_message as the detailed report if necessary.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        is_successful: z.boolean().describe("Whether the task completed successfully. Mandatory."),
      }),
    },
    async (args) => {
      logToolCall("finalize_task", args);
      const unknownMsg = validateUnknownParams("finalize_task", args, new Set(["bus_id", "assessment", "clarification", "is_successful"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("finalize_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      const clarification = typeof (args as { clarification?: string }).clarification === "string" ? (args as { clarification: string }).clarification : "";
      const rawSuccess = (args as { is_successful?: boolean | string }).is_successful;
      const is_successful =
        typeof rawSuccess === "boolean"
          ? rawSuccess
          : typeof rawSuccess === "string"
            ? rawSuccess.toLowerCase() !== "false" && rawSuccess.toLowerCase() !== "0"
            : true;
      logClarification("finalize_task", args);
      logAssessment("finalize_task", args);
      recipeStore.finalize(is_successful, assessment, clarification);
      return toolResult("Task finalized. Write \"Done.\"");
    }
  );

  const TOOL_BASE = new Set(["bus_id", "assessment", "clarification"]);

  server.registerTool(
    "secrets_list",
    {
      description:
        "List all secrets. Returns JSON array of {id, detailed_description, first_factor, first_factor_type, has_totp}.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("secrets_list", args);
      const unknownMsg = validateUnknownParams("secrets_list", args, TOOL_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("secrets_list", args);
      logAssessment("secrets_list", args);
      const list = secretsList();
      const resultText = JSON.stringify(list);
      recipeStore.appendToolCall("secrets_list", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_get",
    {
      description:
        "Get a secret value by id (UUID). If TOTP seed is configured, returns JSON with value, totp_code, and totp_expires_in_seconds.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        id: z.string().describe("Secret id from secrets_list"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("secrets_get", args);
      const unknownMsg = validateUnknownParams("secrets_get", args, new Set([...TOOL_BASE, "id"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_get", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      logClarification("secrets_get", args);
      logAssessment("secrets_get", args);
      const result = await secretsGet(id);
      const resultText =
        result === null
          ? `Secret "${id}" not found.`
          : typeof result === "string"
            ? result
            : JSON.stringify(result);
      recipeStore.appendToolCall("secrets_get", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_set",
    {
      description:
        "Set a secret. Use force=true to overwrite. Optional totp_secret: Base32 TOTP seed for 2FA code generation.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        detailed_description: z.string(),
        first_factor: z.string(),
        first_factor_type: z.string(),
        value: z.string(),
        totp_secret: z.string().optional().describe("Optional Base32 TOTP seed for 2FA code generation"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        force: z.boolean().optional().default(false),
      }),
    },
    async (args) => {
      logToolCall("secrets_set", args);
      const allowed = new Set([...TOOL_BASE, "detailed_description", "first_factor", "first_factor_type", "value", "totp_secret", "force"]);
      const unknownMsg = validateUnknownParams("secrets_set", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { detailed_description, first_factor, first_factor_type, value, totp_secret, force = false } =
        args as Record<string, unknown>;
      logClarification("secrets_set", args);
      logAssessment("secrets_set", args);
      const id = secretsSet(
        String(detailed_description),
        String(first_factor),
        String(first_factor_type),
        String(value),
        Boolean(force),
        typeof totp_secret === "string" ? totp_secret : undefined
      );
      const resultText = `Secret set. id="${id}"`;
      recipeStore.appendToolCall("secrets_set", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_delete",
    {
      description: "Delete a secret by id.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        id: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("secrets_delete", args);
      const unknownMsg = validateUnknownParams("secrets_delete", args, new Set([...TOOL_BASE, "id"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      logClarification("secrets_delete", args);
      logAssessment("secrets_delete", args);
      secretsDelete(id);
      recipeStore.appendToolCall("secrets_delete", args, `Secret "${id}" deleted.`);
      return toolResult(`Secret "${id}" deleted.`);
    }
  );

  server.registerTool(
    "config_list",
    {
      description: "List all agent config entries.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("config_list", args);
      const unknownMsg = validateUnknownParams("config_list", args, TOOL_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("config_list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("config_list", args);
      logAssessment("config_list", args);
      const list = agentConfigList();
      const resultText = JSON.stringify(list);
      recipeStore.appendToolCall("config_list", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "config_set",
    {
      description: "Set agent config. Use force=true to overwrite.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        detailed_description: z.string(),
        value: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        force: z.boolean().optional().default(false),
      }),
    },
    async (args) => {
      logToolCall("config_set", args);
      const allowed = new Set([...TOOL_BASE, "detailed_description", "value", "force"]);
      const unknownMsg = validateUnknownParams("config_set", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("config_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { detailed_description, value, force = false } = args as Record<string, unknown>;
      logClarification("config_set", args);
      logAssessment("config_set", args);
      const id = agentConfigSet(String(detailed_description), String(value), Boolean(force));
      const resultText = `Config set. id="${id}"`;
      recipeStore.appendToolCall("config_set", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "config_delete",
    {
      description: "Delete agent config by id.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        id: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("config_delete", args);
      const unknownMsg = validateUnknownParams("config_delete", args, new Set([...TOOL_BASE, "id"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("config_delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      logClarification("config_delete", args);
      logAssessment("config_delete", args);
      agentConfigDelete(id);
      recipeStore.appendToolCall("config_delete", args, `Config "${id}" deleted.`);
      return toolResult(`Config "${id}" deleted.`);
    }
  );

  // --- Mail (IMAP) tools ---
  const MAIL_BASE = new Set([...TOOL_BASE]);

  server.registerTool(
    "mail__connect",
    {
      description: "Connect to IMAP server. Explicit params: host, port, user, pass. secure=true by default.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        host: z.string(),
        port: z.number(),
        user: z.string(),
        pass: z.string(),
        secure: z.boolean().optional().default(true),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__connect", args);
      const allowed = new Set([...MAIL_BASE, "host", "port", "user", "pass", "secure"]);
      const unknownMsg = validateUnknownParams("mail__connect", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__connect", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { host: string; port: number; user: string; pass: string; secure?: boolean };
      logClarification("mail__connect", args);
      logAssessment("mail__connect", args);
      try {
        await mailConnect({ host: a.host, port: a.port, user: a.user, pass: a.pass, secure: a.secure });
        const { busId, messageCount } = await mailInitInboxAndWatch(a.user);
        recipeStore.appendToolCall("mail__connect", args, "Connected.");
        return toolResult(`Connected. Bus ${busId} created. ${messageCount} message(s) loaded.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__connect", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__disconnect",
    {
      description: "Disconnect from IMAP server. Connection is kept alive automatically; prefer not to disconnect.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("mail__disconnect", args);
      const unknownMsg = validateUnknownParams("mail__disconnect", args, MAIL_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__disconnect", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("mail__disconnect", args);
      logAssessment("mail__disconnect", args);
      await mailDisconnect();
      recipeStore.appendToolCall("mail__disconnect", args, "Disconnected.");
      return toolResult("Disconnected.");
    }
  );

  server.registerTool(
    "mail__list",
    {
      description: "List mailboxes. Optional statusQuery JSON: {messages, unseen, uidNext, uidValidity, recent, highestModseq}.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        statusQuery: z.string().optional().describe("JSON object e.g. {\"messages\":true,\"unseen\":true}"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__list", args);
      const allowed = new Set([...MAIL_BASE, "statusQuery"]);
      const unknownMsg = validateUnknownParams("mail__list", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("mail__list", args);
      logAssessment("mail__list", args);
      try {
        const opts = (args as { statusQuery?: string }).statusQuery
          ? { statusQuery: JSON.parse((args as { statusQuery: string }).statusQuery) }
          : undefined;
        const list = await mailList(opts);
        const text = JSON.stringify(list, null, 2);
        recipeStore.appendToolCall("mail__list", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__list", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__list_tree",
    {
      description: "List mailboxes as tree structure.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("mail__list_tree", args);
      const unknownMsg = validateUnknownParams("mail__list_tree", args, MAIL_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__list_tree", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("mail__list_tree", args);
      logAssessment("mail__list_tree", args);
      try {
        const tree = await mailListTree();
        const text = JSON.stringify(tree, null, 2);
        recipeStore.appendToolCall("mail__list_tree", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__list_tree", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_open",
    {
      description: "Open/select a mailbox. Use as current mailbox for subsequent operations.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        readOnly: z.boolean().optional().default(false),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__mailbox_open", args);
      const allowed = new Set([...MAIL_BASE, "path", "readOnly"]);
      const unknownMsg = validateUnknownParams("mail__mailbox_open", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_open", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path, readOnly = false } = args as { path: string; readOnly?: boolean };
      logClarification("mail__mailbox_open", args);
      logAssessment("mail__mailbox_open", args);
      try {
        await mailMailboxOpen(path, readOnly);
        recipeStore.appendToolCall("mail__mailbox_open", args, `Opened ${path}`);
        return toolResult(`Opened ${path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_open", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_close",
    {
      description: "Close the currently open mailbox.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("mail__mailbox_close", args);
      const unknownMsg = validateUnknownParams("mail__mailbox_close", args, MAIL_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_close", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("mail__mailbox_close", args);
      logAssessment("mail__mailbox_close", args);
      try {
        await mailMailboxClose();
        recipeStore.appendToolCall("mail__mailbox_close", args, "Closed.");
        return toolResult("Closed.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_close", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_create",
    {
      description: "Create a new mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__mailbox_create", args);
      const allowed = new Set([...MAIL_BASE, "path"]);
      const unknownMsg = validateUnknownParams("mail__mailbox_create", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_create", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path } = args as { path: string };
      logClarification("mail__mailbox_create", args);
      logAssessment("mail__mailbox_create", args);
      try {
        const result = await mailMailboxCreate(path);
        const text = JSON.stringify(result);
        recipeStore.appendToolCall("mail__mailbox_create", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_create", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_rename",
    {
      description: "Rename a mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        oldPath: z.string(),
        newPath: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__mailbox_rename", args);
      const allowed = new Set([...MAIL_BASE, "oldPath", "newPath"]);
      const unknownMsg = validateUnknownParams("mail__mailbox_rename", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_rename", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { oldPath, newPath } = args as { oldPath: string; newPath: string };
      logClarification("mail__mailbox_rename", args);
      logAssessment("mail__mailbox_rename", args);
      try {
        await mailMailboxRename(oldPath, newPath);
        recipeStore.appendToolCall("mail__mailbox_rename", args, "Renamed.");
        return toolResult("Renamed.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_rename", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_delete",
    {
      description: "Delete a mailbox and all its messages.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__mailbox_delete", args);
      const allowed = new Set([...MAIL_BASE, "path"]);
      const unknownMsg = validateUnknownParams("mail__mailbox_delete", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path } = args as { path: string };
      logClarification("mail__mailbox_delete", args);
      logAssessment("mail__mailbox_delete", args);
      try {
        await mailMailboxDelete(path);
        recipeStore.appendToolCall("mail__mailbox_delete", args, "Deleted.");
        return toolResult("Deleted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_delete", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_subscribe",
    {
      description: "Subscribe to a mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__mailbox_subscribe", args);
      const allowed = new Set([...MAIL_BASE, "path"]);
      const unknownMsg = validateUnknownParams("mail__mailbox_subscribe", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_subscribe", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path } = args as { path: string };
      logClarification("mail__mailbox_subscribe", args);
      logAssessment("mail__mailbox_subscribe", args);
      try {
        await mailMailboxSubscribe(path);
        recipeStore.appendToolCall("mail__mailbox_subscribe", args, "Subscribed.");
        return toolResult("Subscribed.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_subscribe", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__mailbox_unsubscribe",
    {
      description: "Unsubscribe from a mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__mailbox_unsubscribe", args);
      const allowed = new Set([...MAIL_BASE, "path"]);
      const unknownMsg = validateUnknownParams("mail__mailbox_unsubscribe", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__mailbox_unsubscribe", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path } = args as { path: string };
      logClarification("mail__mailbox_unsubscribe", args);
      logAssessment("mail__mailbox_unsubscribe", args);
      try {
        await mailMailboxUnsubscribe(path);
        recipeStore.appendToolCall("mail__mailbox_unsubscribe", args, "Unsubscribed.");
        return toolResult("Unsubscribed.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__mailbox_unsubscribe", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__status",
    {
      description: "Get mailbox status without selecting. query JSON: {messages, unseen, uidNext, uidValidity, recent, highestModseq}.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        query: z.string().describe("JSON e.g. {\"messages\":true,\"unseen\":true}"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__status", args);
      const allowed = new Set([...MAIL_BASE, "path", "query"]);
      const unknownMsg = validateUnknownParams("mail__status", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__status", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path, query } = args as { path: string; query: string };
      logClarification("mail__status", args);
      logAssessment("mail__status", args);
      try {
        const status = await mailStatus(path, JSON.parse(query));
        const text = JSON.stringify(status);
        recipeStore.appendToolCall("mail__status", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__status", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__get_quota",
    {
      description: "Get quota for a mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__get_quota", args);
      const allowed = new Set([...MAIL_BASE, "path"]);
      const unknownMsg = validateUnknownParams("mail__get_quota", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__get_quota", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { path } = args as { path: string };
      logClarification("mail__get_quota", args);
      logAssessment("mail__get_quota", args);
      try {
        const quota = await mailGetQuota(path);
        const text = JSON.stringify(quota);
        recipeStore.appendToolCall("mail__get_quota", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__get_quota", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__fetch_all",
    {
      description: "Fetch messages. range: '1:*', '1:10', etc. query JSON: {envelope, flags, source, bodyStructure}. mailbox optional if already open.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        query: z.string().default("{\"envelope\":true,\"flags\":true}"),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__fetch_all", args);
      const allowed = new Set([...MAIL_BASE, "range", "query", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__fetch_all", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__fetch_all", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; query?: string; uid?: boolean; mailbox?: string };
      logClarification("mail__fetch_all", args);
      logAssessment("mail__fetch_all", args);
      try {
        const query = a.query ? JSON.parse(a.query) : { envelope: true, flags: true };
        const msgs = await mailFetchAll(a.range, query, { uid: a.uid ?? true, mailbox: a.mailbox });
        const text = JSON.stringify(msgs, null, 2);
        recipeStore.appendToolCall("mail__fetch_all", args, text.slice(0, 50000));
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__fetch_all", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__fetch_one",
    {
      description: "Fetch a single message. seq: '*' for latest, or number. query JSON. mailbox optional.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        seq: z.string(),
        query: z.string().default("{\"envelope\":true,\"flags\":true,\"source\":true}"),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__fetch_one", args);
      const allowed = new Set([...MAIL_BASE, "seq", "query", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__fetch_one", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__fetch_one", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { seq: string; query?: string; uid?: boolean; mailbox?: string };
      logClarification("mail__fetch_one", args);
      logAssessment("mail__fetch_one", args);
      try {
        const query = a.query ? JSON.parse(a.query) : { envelope: true, flags: true, source: true };
        const msg = await mailFetchOne(a.seq, query, { uid: a.uid ?? true, mailbox: a.mailbox });
        const text = JSON.stringify(msg, null, 2);
        recipeStore.appendToolCall("mail__fetch_one", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__fetch_one", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__download",
    {
      description: "Download message or body part. Saves to ~/Downloads. part: body part ID (e.g. '1', '2') or omit for full message.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        part: z.string().optional().default(""),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__download", args);
      const allowed = new Set([...MAIL_BASE, "range", "part", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__download", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__download", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; part?: string; uid?: boolean; mailbox?: string };
      logClarification("mail__download", args);
      logAssessment("mail__download", args);
      try {
        const result = await mailDownload(a.range, a.part || "", { uid: a.uid ?? true, mailbox: a.mailbox });
        recipeStore.appendToolCall("mail__download", args, result);
        return toolResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__download", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__search",
    {
      description: "Search messages. query JSON: {seen:false}, {from:'x'}, {or:[{a:1},{b:2}]}, {gmraw:'...'} for Gmail. Returns UIDs.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        query: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__search", args);
      const allowed = new Set([...MAIL_BASE, "query", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__search", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__search", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { query: string; uid?: boolean; mailbox?: string };
      logClarification("mail__search", args);
      logAssessment("mail__search", args);
      try {
        const query = JSON.parse(a.query);
        const uids = await mailSearch(query, { uid: a.uid ?? true, mailbox: a.mailbox });
        const text = JSON.stringify(uids);
        recipeStore.appendToolCall("mail__search", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__search", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_delete",
    {
      description: "Delete messages. mailbox optional if already open.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_delete", args);
      const allowed = new Set([...MAIL_BASE, "range", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_delete", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { bus_id: string; range: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_delete", args);
      logAssessment("mail__message_delete", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageDelete(a.range, a.uid ?? true);
        if (a.bus_id.startsWith("email-")) {
          const uids = parseUidRange(a.range);
          if (uids.length > 0) {
            removeMessagesFromBusHistoryByMailUids(a.bus_id, uids);
          }
        }
        recipeStore.appendToolCall("mail__message_delete", args, "Deleted.");
        return toolResult("Deleted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_delete", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_copy",
    {
      description: "Copy messages to another mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        destination: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_copy", args);
      const allowed = new Set([...MAIL_BASE, "range", "destination", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_copy", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_copy", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; destination: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_copy", args);
      logAssessment("mail__message_copy", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        const result = await mailMessageCopy(a.range, a.destination, a.uid ?? true);
        const text = JSON.stringify(result);
        recipeStore.appendToolCall("mail__message_copy", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_copy", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_move",
    {
      description: "Move messages to another mailbox.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        destination: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_move", args);
      const allowed = new Set([...MAIL_BASE, "range", "destination", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_move", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_move", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; destination: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_move", args);
      logAssessment("mail__message_move", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageMove(a.range, a.destination, a.uid ?? true);
        recipeStore.appendToolCall("mail__message_move", args, "Moved.");
        return toolResult("Moved.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_move", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_flags_add",
    {
      description: "Add flags to messages. flags: ['\\\\Seen'], ['\\\\Flagged'], etc.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        flags: z.string().describe("JSON array e.g. [\"\\\\Seen\"]"),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_flags_add", args);
      const allowed = new Set([...MAIL_BASE, "range", "flags", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_flags_add", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_flags_add", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; flags: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_flags_add", args);
      logAssessment("mail__message_flags_add", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageFlagsAdd(a.range, JSON.parse(a.flags), a.uid ?? true);
        recipeStore.appendToolCall("mail__message_flags_add", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_flags_add", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_flags_remove",
    {
      description: "Remove flags from messages.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        flags: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_flags_remove", args);
      const allowed = new Set([...MAIL_BASE, "range", "flags", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_flags_remove", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_flags_remove", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; flags: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_flags_remove", args);
      logAssessment("mail__message_flags_remove", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageFlagsRemove(a.range, JSON.parse(a.flags), a.uid ?? true);
        recipeStore.appendToolCall("mail__message_flags_remove", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_flags_remove", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_flags_set",
    {
      description: "Set exact flags for messages (replaces existing).",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        flags: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_flags_set", args);
      const allowed = new Set([...MAIL_BASE, "range", "flags", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_flags_set", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_flags_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; flags: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_flags_set", args);
      logAssessment("mail__message_flags_set", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageFlagsSet(a.range, JSON.parse(a.flags), a.uid ?? true);
        recipeStore.appendToolCall("mail__message_flags_set", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_flags_set", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__set_flag_color",
    {
      description: "Set flag color. color: red, orange, yellow, green, blue, purple.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        color: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__set_flag_color", args);
      const allowed = new Set([...MAIL_BASE, "range", "color", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__set_flag_color", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__set_flag_color", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; color: string; uid?: boolean; mailbox?: string };
      logClarification("mail__set_flag_color", args);
      logAssessment("mail__set_flag_color", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailSetFlagColor(a.range, a.color, a.uid ?? true);
        recipeStore.appendToolCall("mail__set_flag_color", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__set_flag_color", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_labels_add",
    {
      description: "Add Gmail labels to messages.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        labels: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_labels_add", args);
      const allowed = new Set([...MAIL_BASE, "range", "labels", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_labels_add", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_labels_add", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; labels: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_labels_add", args);
      logAssessment("mail__message_labels_add", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageLabelsAdd(a.range, JSON.parse(a.labels), a.uid ?? true);
        recipeStore.appendToolCall("mail__message_labels_add", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_labels_add", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_labels_remove",
    {
      description: "Remove Gmail labels from messages.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        labels: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_labels_remove", args);
      const allowed = new Set([...MAIL_BASE, "range", "labels", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_labels_remove", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_labels_remove", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; labels: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_labels_remove", args);
      logAssessment("mail__message_labels_remove", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageLabelsRemove(a.range, JSON.parse(a.labels), a.uid ?? true);
        recipeStore.appendToolCall("mail__message_labels_remove", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_labels_remove", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__message_labels_set",
    {
      description: "Set exact Gmail labels for messages.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        range: z.string(),
        labels: z.string(),
        uid: z.boolean().optional().default(true),
        mailbox: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__message_labels_set", args);
      const allowed = new Set([...MAIL_BASE, "range", "labels", "uid", "mailbox"]);
      const unknownMsg = validateUnknownParams("mail__message_labels_set", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__message_labels_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { range: string; labels: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_labels_set", args);
      logAssessment("mail__message_labels_set", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageLabelsSet(a.range, JSON.parse(a.labels), a.uid ?? true);
        recipeStore.appendToolCall("mail__message_labels_set", args, "Done.");
        return toolResult("Done.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__message_labels_set", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "mail__append",
    {
      description: "Append a message to a mailbox. content: RFC822 format. flags optional.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        path: z.string(),
        content: z.string(),
        flags: z.string().optional(),
        idate: z.string().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("mail__append", args);
      const allowed = new Set([...MAIL_BASE, "path", "content", "flags", "idate"]);
      const unknownMsg = validateUnknownParams("mail__append", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("mail__append", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { path: string; content: string; flags?: string; idate?: string };
      logClarification("mail__append", args);
      logAssessment("mail__append", args);
      try {
        const flags = a.flags ? JSON.parse(a.flags) : undefined;
        const result = await mailAppend(a.path, a.content, flags, a.idate);
        const text = JSON.stringify(result);
        recipeStore.appendToolCall("mail__append", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("mail__append", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  // --- CalDAV tools ---
  const CALDAV_BASE = new Set([...TOOL_BASE]);

  server.registerTool(
    "caldav__oauth_browser",
    {
      description:
        "Start Google CalDAV OAuth flow. Opens the OAuth URL in the agent's Chrome browser. User signs in; Google redirects to localhost where tokens are displayed. Read the tokens from the page (pre#caldav-tokens), save via secrets_set, then call caldav__connect with credentials_secret_id. Requires CalDAV Google Client ID and Secret in app settings.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__oauth_browser", args);
      const unknownMsg = validateUnknownParams("caldav__oauth_browser", args, CALDAV_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__oauth_browser", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("caldav__oauth_browser", args);
      logAssessment("caldav__oauth_browser", args);
      const clientId = config.appConfig?.caldavGoogleClientId?.trim();
      const clientSecret = config.appConfig?.caldavGoogleClientSecret?.trim();
      if (!clientId || !clientSecret) {
        recipeStore.appendToolCall("caldav__oauth_browser", args, "Configure CalDAV Google Client ID and Secret in app settings");
        return toolResult("Error: Configure CalDAV Google Client ID and Secret in app settings first.");
      }
      try {
        const { url, redirectUrl, closeServer } = await startGoogleOAuthBrowserServer(clientId, clientSecret);
        try {
          const result = await callChromeTool("new_page", { url });
          const text = (result.content ?? []).map((c) => (c as { text?: string }).text).filter(Boolean).join("\n");
          if (result.isError) {
            recipeStore.appendToolCall("caldav__oauth_browser", args, text || "Failed to open page");
            return toolResult(`Error opening OAuth page: ${text || "Chrome may not be connected"}`);
          }
        } catch (err) {
          closeServer();
          throw err;
        }
        const instruction =
          `OAuth page opened in Chrome. User signs in; Google redirects to ${redirectUrl}. ` +
          `The redirect page displays tokens in <pre id="caldav-tokens">. Read the JSON (refreshToken, username), ` +
          `save via secrets_set (value = JSON string), then call caldav__connect with credentials_secret_id.`;
        const out = JSON.stringify({ url, redirectUrl, instruction }, null, 2);
        recipeStore.appendToolCall("caldav__oauth_browser", args, out);
        return toolResult(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__oauth_browser", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__connect",
    {
      description:
        "Connect to CalDAV. Basic: serverUrl, username, password. OAuth (Google): authMethod=OAuth, provider=google, credentials_secret_id (from secrets_set after caldav__oauth_browser). For OAuth, run caldav__oauth_browser first to get tokens.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        authMethod: z.enum(["Basic", "OAuth"]),
        serverUrl: z.string().optional().describe("For Basic: CalDAV server URL. For Google OAuth: omit (uses Google CalDAV)"),
        username: z.string().optional(),
        password: z.string().optional(),
        provider: z.enum(["google"]).optional().describe("For OAuth: provider (google only for now)"),
        refreshToken: z.string().optional().describe("From secrets. If missing, OAuth flow runs."),
        credentials_secret_id: z.string().optional().describe("Secret id with refreshToken, clientId, clientSecret, username"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__connect", args);
      const allowed = new Set([
        ...CALDAV_BASE,
        "authMethod",
        "serverUrl",
        "username",
        "password",
        "provider",
        "refreshToken",
        "credentials_secret_id",
      ]);
      const unknownMsg = validateUnknownParams("caldav__connect", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__connect", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as {
        authMethod: "Basic" | "OAuth";
        serverUrl?: string;
        username?: string;
        password?: string;
        provider?: string;
        refreshToken?: string;
        credentials_secret_id?: string;
      };
      logClarification("caldav__connect", args);
      logAssessment("caldav__connect", args);
      try {
        const clientId = config.appConfig?.caldavGoogleClientId?.trim();
        const clientSecret = config.appConfig?.caldavGoogleClientSecret?.trim();

        if (a.authMethod === "OAuth") {
          if (!clientId || !clientSecret) {
            recipeStore.appendToolCall("caldav__connect", args, "Configure CalDAV Google Client ID and Secret in app settings");
            return toolResult("Error: Configure CalDAV Google Client ID and Secret in app settings first.");
          }
          let refreshToken = a.refreshToken;
          let username = a.username;
          if (a.credentials_secret_id) {
            const secret = await secretsGet(a.credentials_secret_id);
            const secretValue = typeof secret === "string" ? secret : secret && typeof secret === "object" && "value" in secret ? secret.value : null;
            if (secretValue) {
              try {
                const cred = JSON.parse(secretValue) as { refreshToken?: string; username?: string };
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
              refreshToken,
              username,
              clientId,
              clientSecret,
            },
            { googleClientId: clientId, googleClientSecret: clientSecret }
          );
        } else {
          if (!a.serverUrl || !a.username || !a.password) {
            recipeStore.appendToolCall("caldav__connect", args, "Basic auth requires serverUrl, username, password");
            return toolResult("Error: Basic auth requires serverUrl, username, password");
          }
          await caldavConnect({
            authMethod: "Basic",
            serverUrl: a.serverUrl,
            username: a.username,
            password: a.password,
          });
        }

        const account = a.authMethod === "OAuth" ? (a.username ?? "google") : a.username!;
        const { calendars } = await caldavInitAndWatch(account);
        for (const cal of calendars) {
          ensureBus(cal.busId, `Calendar: ${cal.displayName}`);
          const props = loadBusProperties(cal.busId);
          if (props) saveBusProperties({ ...props, url: cal.url });
        }
        recipeStore.appendToolCall("caldav__connect", args, "Connected.");
        return toolResult(`Connected. Bus(es): ${calendars.map((c) => c.busId).join(", ")}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__connect", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__disconnect",
    {
      description: "Disconnect from CalDAV.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("caldav__disconnect", args);
      const unknownMsg = validateUnknownParams("caldav__disconnect", args, CALDAV_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__disconnect", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("caldav__disconnect", args);
      logAssessment("caldav__disconnect", args);
      await caldavDisconnect();
      recipeStore.appendToolCall("caldav__disconnect", args, "Disconnected.");
      return toolResult("Disconnected.");
    }
  );

  server.registerTool(
    "caldav__list_calendars",
    {
      description: "List CalDAV calendars.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("caldav__list_calendars", args);
      const unknownMsg = validateUnknownParams("caldav__list_calendars", args, CALDAV_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__list_calendars", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("caldav__list_calendars", args);
      logAssessment("caldav__list_calendars", args);
      try {
        const list = await caldavListCalendars();
        const text = JSON.stringify(list, null, 2);
        recipeStore.appendToolCall("caldav__list_calendars", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__list_calendars", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__list_events",
    {
      description: "List events in a calendar. start and end in ISO 8601 (e.g. 2025-03-10T00:00:00Z).",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        calendarUrl: z.string(),
        start: z.string(),
        end: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__list_events", args);
      const allowed = new Set([...CALDAV_BASE, "calendarUrl", "start", "end"]);
      const unknownMsg = validateUnknownParams("caldav__list_events", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__list_events", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { calendarUrl: string; start: string; end: string };
      logClarification("caldav__list_events", args);
      logAssessment("caldav__list_events", args);
      try {
        const objects = await caldavListEvents(a.calendarUrl, a.start, a.end);
        const list = objects.map((o) => ({ url: o.url, etag: o.etag, data: typeof o.data === "string" ? o.data.slice(0, 500) : "" }));
        const text = JSON.stringify(list, null, 2);
        recipeStore.appendToolCall("caldav__list_events", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__list_events", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__get_event",
    {
      description: "Get a single event by object URL.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        calendarUrl: z.string(),
        objectUrl: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__get_event", args);
      const allowed = new Set([...CALDAV_BASE, "calendarUrl", "objectUrl"]);
      const unknownMsg = validateUnknownParams("caldav__get_event", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__get_event", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { calendarUrl: string; objectUrl: string };
      logClarification("caldav__get_event", args);
      logAssessment("caldav__get_event", args);
      try {
        const obj = await caldavGetEvent(a.calendarUrl, a.objectUrl);
        if (!obj) {
          recipeStore.appendToolCall("caldav__get_event", args, "Not found");
          return toolResult("Event not found.");
        }
        const text = JSON.stringify({ url: obj.url, etag: obj.etag, data: obj.data }, null, 2);
        recipeStore.appendToolCall("caldav__get_event", args, text);
        return toolResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__get_event", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__create_event",
    {
      description: "Create a calendar event. filename should end in .ics. iCalString is the full iCalendar data.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        calendarUrl: z.string(),
        filename: z.string(),
        iCalString: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__create_event", args);
      const allowed = new Set([...CALDAV_BASE, "calendarUrl", "filename", "iCalString"]);
      const unknownMsg = validateUnknownParams("caldav__create_event", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__create_event", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { calendarUrl: string; filename: string; iCalString: string };
      logClarification("caldav__create_event", args);
      logAssessment("caldav__create_event", args);
      try {
        await caldavCreateEvent(a.calendarUrl, a.filename, a.iCalString);
        recipeStore.appendToolCall("caldav__create_event", args, "Created.");
        return toolResult("Event created.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__create_event", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__update_event",
    {
      description: "Update a calendar event. Pass the full object from get_event with data replaced by new iCalString.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        calendarObject: z.string().describe("JSON: {url, etag, data}. data = new iCalString"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__update_event", args);
      const allowed = new Set([...CALDAV_BASE, "calendarObject"]);
      const unknownMsg = validateUnknownParams("caldav__update_event", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__update_event", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { calendarObject: string };
      logClarification("caldav__update_event", args);
      logAssessment("caldav__update_event", args);
      try {
        const obj = JSON.parse(a.calendarObject) as { url: string; etag?: string; data: string };
        await caldavUpdateEvent(obj, obj.data);
        recipeStore.appendToolCall("caldav__update_event", args, "Updated.");
        return toolResult("Event updated.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__update_event", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__delete_event",
    {
      description: "Delete a calendar event. Pass the object from get_event.",
      inputSchema: z.object({
        bus_id: BUS_ID_PARAM,
        calendarObject: z.string().describe("JSON from get_event: {url, etag, data}. Include data for history sync."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("caldav__delete_event", args);
      const allowed = new Set([...CALDAV_BASE, "calendarObject"]);
      const unknownMsg = validateUnknownParams("caldav__delete_event", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__delete_event", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const a = args as { bus_id: string; calendarObject: string };
      logClarification("caldav__delete_event", args);
      logAssessment("caldav__delete_event", args);
      try {
        const obj = JSON.parse(a.calendarObject) as { url: string; etag?: string; data?: string };
        await caldavDeleteEvent(obj);
        const eventUid = typeof obj.data === "string" ? parseIcsEventUid(obj.data) : undefined;
        if (eventUid) {
          removeEventTaskMapping(eventUid);
          removeMessagesFromBusHistoryByEventUids(a.bus_id, [eventUid]);
          config.onCaldavEventDeleted?.(eventUid, a.bus_id);
        }
        caldavRemoveFromLastKnown(obj.url);
        recipeStore.appendToolCall("caldav__delete_event", args, "Deleted.");
        return toolResult("Event deleted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recipeStore.appendToolCall("caldav__delete_event", args, msg);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  server.registerTool(
    "caldav__status",
    {
      description: "Check CalDAV connection status.",
      inputSchema: z.object({ bus_id: BUS_ID_PARAM, assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("caldav__status", args);
      const unknownMsg = validateUnknownParams("caldav__status", args, CALDAV_BASE);
      if (unknownMsg) {
        recipeStore.appendToolCall("caldav__status", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      logClarification("caldav__status", args);
      logAssessment("caldav__status", args);
      const connected = isCaldavConnected();
      const text = JSON.stringify({ connected }, null, 2);
      recipeStore.appendToolCall("caldav__status", args, text);
      return toolResult(text);
    }
  );

  return server;
}

export async function startMcpServer(config: McpServerConfig): Promise<Server> {
  const transports: Record<string, SSEServerTransport> = {};
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/sse", async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    const mcpServer = await createMcpServer(config);
    await mcpServer.connect(transport);
    res.on("close", () => {
      delete transports[transport.sessionId];
    });
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).send("Missing sessionId");
      return;
    }
    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr?.port ? addr.port : 0;
      console.log(`[YAAIA MCP] Listening on port ${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

export function getMcpServerPort(server: Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr?.port ? addr.port : 0;
}

export async function stopChromeMcp(): Promise<void> {
  await disconnectChromeMcp();
}

export async function stopKbMcp(): Promise<void> {
  await disconnectKbMcp();
}

export async function stopMailClient(): Promise<void> {
  await mailDisconnect();
}

export async function stopCaldavClient(): Promise<void> {
  await caldavDisconnect();
}
