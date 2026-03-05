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
import {
  secretsList,
  secretsGet,
  secretsSet,
  secretsDelete,
} from "../secrets-store.js";
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

const BROWSER_URL = "http://127.0.0.1:9222";

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

function stripAssessmentClarification(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
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
    assessment: ASSESSMENT_PARAM,
    clarification: CLARIFICATION_PARAM,
  };
  for (const [key, prop] of Object.entries(props)) {
    if (key === "assessment" || key === "clarification") continue;
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
    assessment: ASSESSMENT_PARAM,
    clarification: CLARIFICATION_PARAM,
  };
  for (const [key, prop] of Object.entries(props)) {
    if (key === "assessment" || key === "clarification") continue;
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
    if (!required.includes("assessment")) required.push("assessment");
    if (!required.includes("clarification")) required.push("clarification");

    server.registerTool(
      name,
      {
        description: (tool.description ?? `Chrome DevTools: ${name}`) + " Always provide assessment and clarification.",
        inputSchema: buildChromeToolInputSchema(baseSchema, required),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        logToolCall(name, args);
        logClarification(name, args);
        logAssessment(name, args);
        const forwardArgs = applyDefaultsNoFocusSteal(
          name,
          stripAssessmentClarification(a)
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
    if (!required.includes("assessment")) required.push("assessment");
    if (!required.includes("clarification")) required.push("clarification");

    server.registerTool(
      name,
      {
        description: (tool.description ?? `KB/QMD: ${qmdName}`) + " Always provide assessment and clarification.",
        inputSchema: buildKbToolInputSchema(baseSchema, required),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        logToolCall(name, args);
        logClarification(name, args);
        logAssessment(name, args);
        let forwardArgs = stripAssessmentClarification(a);
        if (qmdName === "get" && typeof forwardArgs.file === "string") {
          const f = forwardArgs.file.trim();
          if (f && !f.startsWith("qmd://") && !f.startsWith("#")) {
            // Pass path as-is: QMD stores actual filesystem paths (e.g. fred_smith.md), not handelized
            forwardArgs = { ...forwardArgs, file: `qmd://${f.replace(/^\/+/, "")}` };
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

  const KB_BASE = new Set(["assessment", "clarification"]);

  server.registerTool(
    "kb__write",
    {
      description: "Create or overwrite a .md or .qmd file in the knowledge base. Requires collection (created if missing). Path is relative to collection root.",
      inputSchema: z.object({
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
    "kb__list",
    {
      description: "List files and folders in a collection. Path is relative to collection root.",
      inputSchema: z.object({
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
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
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
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
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
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
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
    "start_task",
    {
      description: "Start a task. Call at the beginning of a new task.",
      inputSchema: z.object({
        summary: z.string().describe("Short task summary/name"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("start_task", args);
      const unknownMsg = validateUnknownParams("start_task", args, new Set(["summary", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("start_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const summary = typeof (args as { summary?: string }).summary === "string" ? (args as { summary: string }).summary : "";
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      logClarification("start_task", args);
      logAssessment("start_task", args);
      recipeStore.initFromStartTask(summary, assessment);
      config.onStartTask?.({ summary });
      return toolResult("Task started.");
    }
  );

  server.registerTool(
    "finalize_task",
    {
      description: "Mandatory when task is complete. Call before ending. is_successful (true/false) is mandatory. After calling, you may send one optional message as the detailed report.",
      inputSchema: z.object({
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        is_successful: z.boolean().describe("Whether the task completed successfully. Mandatory."),
      }),
    },
    async (args) => {
      logToolCall("finalize_task", args);
      const unknownMsg = validateUnknownParams("finalize_task", args, new Set(["assessment", "clarification", "is_successful"]));
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
      return toolResult("Task finalized. You may send one optional message as the detailed report.");
    }
  );

  server.registerTool(
    "ask_user",
    {
      description: "Ask the user for input. Opens popup with 60-second countdown. Use attempt (0–2) when retrying.",
      inputSchema: z.object({
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        attempt: z.number().optional().default(0).describe("Retry attempt (0–2). Default 0."),
      }),
    },
    async (args) => {
      logToolCall("ask_user", args);
      const unknownMsg = validateUnknownParams("ask_user", args, new Set(["assessment", "clarification", "attempt"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("ask_user", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      const clarification = typeof (args as { clarification?: string }).clarification === "string" ? (args as { clarification: string }).clarification : "";
      const attempt = typeof (args as { attempt?: number }).attempt === "number" ? (args as { attempt: number }).attempt : 0;
      logClarification("ask_user", args);
      logAssessment("ask_user", args);
      config.onAskUserRequest?.({ clarification, assessment, attempt });
      const reply = await waitForUserReply({
        timeoutMs: 60_000,
        onTimeout: config.onAskUserTimeout,
      });
      recipeStore.appendToolCall("ask_user", args, reply);
      return toolResult(reply);
    }
  );

  server.registerTool(
    "secrets_list",
    {
      description: "List all secrets. Returns JSON array of {id, detailed_description, first_factor, first_factor_type}.",
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("secrets_list", args);
      const unknownMsg = validateUnknownParams("secrets_list", args, new Set(["assessment", "clarification"]));
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
      description: "Get a secret value by id (UUID).",
      inputSchema: z.object({
        id: z.string().describe("Secret id from secrets_list"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("secrets_get", args);
      const unknownMsg = validateUnknownParams("secrets_get", args, new Set(["id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_get", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      logClarification("secrets_get", args);
      logAssessment("secrets_get", args);
      const value = secretsGet(id);
      const resultText = value === null ? `Secret "${id}" not found.` : value;
      recipeStore.appendToolCall("secrets_get", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_set",
    {
      description: "Set a secret. Use force=true to overwrite.",
      inputSchema: z.object({
        detailed_description: z.string(),
        first_factor: z.string(),
        first_factor_type: z.string(),
        value: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        force: z.boolean().optional().default(false),
      }),
    },
    async (args) => {
      logToolCall("secrets_set", args);
      const allowed = new Set(["detailed_description", "first_factor", "first_factor_type", "value", "assessment", "clarification", "force"]);
      const unknownMsg = validateUnknownParams("secrets_set", args, allowed);
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { detailed_description, first_factor, first_factor_type, value, force = false } = args as Record<string, unknown>;
      logClarification("secrets_set", args);
      logAssessment("secrets_set", args);
      const id = secretsSet(
        String(detailed_description),
        String(first_factor),
        String(first_factor_type),
        String(value),
        Boolean(force)
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
        id: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("secrets_delete", args);
      const unknownMsg = validateUnknownParams("secrets_delete", args, new Set(["id", "assessment", "clarification"]));
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
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      logToolCall("config_list", args);
      const unknownMsg = validateUnknownParams("config_list", args, new Set(["assessment", "clarification"]));
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
        detailed_description: z.string(),
        value: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        force: z.boolean().optional().default(false),
      }),
    },
    async (args) => {
      logToolCall("config_set", args);
      const allowed = new Set(["detailed_description", "value", "assessment", "clarification", "force"]);
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
        id: z.string(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      logToolCall("config_delete", args);
      const unknownMsg = validateUnknownParams("config_delete", args, new Set(["id", "assessment", "clarification"]));
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
  const MAIL_BASE = new Set(["assessment", "clarification"]);

  server.registerTool(
    "mail__connect",
    {
      description: "Connect to IMAP server. Explicit params: host, port, user, pass. secure=true by default.",
      inputSchema: z.object({
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
        recipeStore.appendToolCall("mail__connect", args, "Connected.");
        return toolResult("Connected.");
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
      description: "Disconnect from IMAP server.",
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
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
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
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
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
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
      const a = args as { range: string; uid?: boolean; mailbox?: string };
      logClarification("mail__message_delete", args);
      logAssessment("mail__message_delete", args);
      try {
        if (a.mailbox) await mailMailboxOpen(a.mailbox);
        await mailMessageDelete(a.range, a.uid ?? true);
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
