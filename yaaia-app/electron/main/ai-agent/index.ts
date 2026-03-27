import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodeBoundary } from "../recipe-store.js";
import { soulGet } from "../soul-store.js";
import {
  appendToBusHistory,
  appendMessage,
  ROOT_BUS_ID,
  getMessagesInWindow,
  getHistoryDb,
} from "../message-db.js";
import { createStreamHandler, parsePrefixedMessages } from "../stream-handler.js";
import type { AgentApiRouteCallbacks } from "../agent-api.js";
import { callCodexApi } from "../codex-client.js";
import { runAgentCode } from "../agent-eval.js";
import { createMemoryEvalBuffers, flushPendingMemoryRows } from "../memory-store.js";
import { generateApiHelpIndex } from "../agent-api-docs.js";
import { getDirectToolsSetupMode } from "../direct-tools.js";
import {
  sendVmScript,
  appendVmEval,
  getVmEvalStdout,
  getVmEvalStderr,
} from "../vm-eval-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const logVerbose = (...args: unknown[]) => {
  if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Agent]", ...args);
};

function persistToolOutputToRoot(toolName: string, resultText: string): void {
  // send_message removed; prefix routing handles appends
  appendToBusHistory(ROOT_BUS_ID, {
    role: "assistant",
    content: `[Tool: ${toolName}]\n${resultText}`,
  });
}
const SYSTEM_PROMPT_PATH = join(__dirname, "../../SYSTEM_PROMPT.md");

function loadSystemPrompt(): string {
  try {
    const base = readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trim();
    const boundary = getCodeBoundary();
    let out = base;
    if (boundary) {
      out += `

## Code block format (bbtag)

**TypeScript:** \`[${boundary}=ts]\` ... \`[/${boundary}]\`
**vm-bash:** \`[${boundary}=vm-bash:N:user]\` ... \`[/${boundary}]\` (N = timeout seconds, user = run as, e.g. root)
- Blocks run sequentially in document order: bash1 → ts1 → bash2 → ts2. Between the opening and closing tags, write **only** the script source. **Do not** wrap that source in Markdown code fences (\`\`\`, \`\`\`typescript, etc.); the tags delimit the code. Triple backticks inside bbtags break extraction and are wrong.
- Content between tags may use backticks, quotes, newlines, etc. as needed for valid code — just never add an extra \`\`\` layer around the whole block.`;
    }
    out += "\n\n" + generateApiHelpIndex({ setupMode: getDirectToolsSetupMode(), codeBoundary: boundary });
    const soul = soulGet();
    if (soul) {
      out += "\n\n## Soul (agent identity)\n\n" + soul;
    }
    return out;
  } catch (err) {
    console.error("[YAAIA Agent] Failed to load SYSTEM_PROMPT.md:", err);
    return "Write code in [{key}=ts]...[/{key}] blocks.";
  }
}

type JsonSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown };

/** Recursively fix schema for Gemini/OpenRouter: array types must have items. */
function fixSchemaForGemini(schema: unknown): unknown {
  if (schema == null || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const type = s.type;
  if (type === "array") {
    if (!s.items) s.items = { type: "string" };
    else fixSchemaForGemini(s.items);
    return s;
  }
  if (type === "object" || !type) {
    const props = s.properties as Record<string, unknown> | undefined;
    if (props && typeof props === "object") {
      for (const key of Object.keys(props)) {
        props[key] = fixSchemaForGemini(props[key]);
      }
    }
  }
  return s;
}

function mcpToolToAnthropic(tool: { name: string; description?: string; inputSchema?: unknown }) {
  const schema = (tool.inputSchema as JsonSchema) ?? { type: "object", properties: {}, required: [] };
  const properties = schema.properties ?? {};
  const propKeys = new Set(Object.keys(properties));
  const required = (schema.required ?? []).filter((k) => propKeys.has(k));
  return {
    name: tool.name,
    description: tool.description ?? `Tool: ${tool.name}`,
    input_schema: {
      type: "object" as const,
      properties,
      required,
    },
  } as const;
}

function mcpToolToOpenAI(tool: { name: string; description?: string; inputSchema?: unknown }) {
  const schema = (tool.inputSchema as JsonSchema) ?? { type: "object", properties: {}, required: [] };
  const fixed = fixSchemaForGemini(JSON.parse(JSON.stringify(schema))) as JsonSchema;
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description ?? `Tool: ${tool.name}`,
      parameters: {
        type: fixed.type ?? "object",
        properties: fixed.properties ?? {},
        required: fixed.required ?? [],
      },
    },
  };
}

function mcpToolResultToText(result: { content?: { type: string; text?: string }[] }): string {
  const content = result.content ?? [];
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim() || "(no output)";
}

const MSG_START = "<<<MSG>>>";
const MSG_END = "<<<END>>>";

function emitStructured(emitChunk: (chunk: string) => void, payload: Record<string, unknown>): void {
  emitChunk(MSG_START + JSON.stringify(payload) + MSG_END);
}

let routeCallbacksForEval: AgentApiRouteCallbacks | null = null;

export function setRouteCallbacksForEval(cb: AgentApiRouteCallbacks | null): void {
  routeCallbacksForEval = cb;
}

/** Detect boundary from first [X=ts] or [X=vm-bash:N:user] in text. Returns null if none found. */
function detectBoundaryFromText(text: string): string | null {
  const tsMatch = text.match(/\[([a-zA-Z0-9_-]+)=ts\]/);
  if (tsMatch) return tsMatch[1];
  const vmMatch = text.match(/\[([a-zA-Z0-9_-]+)=vm-bash:\d+:\w+\]/);
  if (vmMatch) return vmMatch[1];
  return null;
}

export type ExtractedBlock =
  | { type: "vm-bash"; script: string; timeout: number; user: string }
  | { type: "ts"; code: string };

/** Extract vm-bash and ts blocks in document order. [{key}=ts], [{key}=vm-bash:N:user], [/key]. */
function extractBlocks(text: string, boundary: string | null): {
  messageBefore: string;
  blocks: ExtractedBlock[];
  messageAfter: string;
} {
  const blocks: ExtractedBlock[] = [];
  let messageBefore = "";
  let messageAfter = "";

  const effectiveBoundary = boundary ?? detectBoundaryFromText(text);
  if (!effectiveBoundary) {
    messageBefore = text.trim();
    return { messageBefore, blocks, messageAfter };
  }

  const openTs = `[${effectiveBoundary}=ts]`;
  const vmBashRe = new RegExp(`\\[${escapeRe(effectiveBoundary)}=vm-bash:(\\d+):(\\w+)\\]`);
  const closeTag = `[/${effectiveBoundary}]`;

  let i = 0;
  let beforeParts: string[] = [];
  let afterParts: string[] = [];
  let seenAnyBlock = false;

  while (i < text.length) {
    const tsStart = text.indexOf(openTs, i);
    const vmMatch = text.slice(i).match(vmBashRe);
    const vmStart = vmMatch ? i + (vmMatch.index ?? 0) : -1;

    let nextOpen = -1;
    let type: "ts" | "vm-bash" | null = null;
    let timeoutSec = NaN;
    let runAsUser = "";
    let openLen = 0;

    if (tsStart >= 0 && (vmStart < 0 || tsStart <= vmStart)) {
      nextOpen = tsStart;
      type = "ts";
      openLen = openTs.length;
    } else if (vmMatch) {
      nextOpen = vmStart;
      type = "vm-bash";
      timeoutSec = parseInt(vmMatch[1], 10);
      runAsUser = vmMatch[2]?.trim() ?? "";
      openLen = vmMatch[0].length;
    }

    if (type === null || nextOpen < 0) {
      if (!seenAnyBlock) {
        beforeParts.push(text.slice(i));
      } else {
        afterParts.push(text.slice(i));
      }
      break;
    }

    if (nextOpen > i) {
      const gap = text.slice(i, nextOpen);
      if (!seenAnyBlock) beforeParts.push(gap);
      else afterParts.push(gap);
    }

    const contentStart = nextOpen + openLen;
    const closeIdx = text.indexOf(closeTag, contentStart);
    if (closeIdx < 0) {
      if (!seenAnyBlock) beforeParts.push(text.slice(nextOpen));
      else afterParts.push(text.slice(nextOpen));
      break;
    }

    seenAnyBlock = true;
    const content = text.slice(contentStart, closeIdx).trim();
    i = closeIdx + closeTag.length;

    if (type === "ts" && content) {
      blocks.push({ type: "ts", code: content });
    } else if (type === "vm-bash" && !isNaN(timeoutSec) && timeoutSec > 0 && runAsUser) {
      blocks.push({ type: "vm-bash", script: content, timeout: timeoutSec, user: runAsUser });
    }
  }

  messageBefore = beforeParts.join("").trim();
  messageAfter = afterParts.join("").trim();

  if (!blocks.length && boundary) {
    const detected = detectBoundaryFromText(text);
    if (detected && detected !== boundary) {
      return extractBlocks(text, detected);
    }
  }
  return { messageBefore, blocks, messageAfter };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Legacy: extract first ts block only. */
function extractCodeBlock(text: string): { messageBefore: string; code: string | null; messageAfter: string } {
  const { messageBefore, blocks, messageAfter } = extractBlocks(text, getCodeBoundary());
  const firstTs = blocks.find((b) => b.type === "ts");
  return { messageBefore, code: firstTs?.code ?? null, messageAfter };
}

function extractBusIdFromPrefix(s: string): { busId: string; rest: string } {
  const trimmed = (s ?? "").trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const busId = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();
    return { busId: busId || ROOT_BUS_ID, rest };
  }
  return { busId: ROOT_BUS_ID, rest: trimmed };
}


function emitToolBlockResult(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  emitChunk: (chunk: string) => void
): void {
  const escaped = resultText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const accordionHtml = `<details class="tool-result-debug"><summary>${toolName}</summary><pre>${escaped}</pre></details>`;
  emitStructured(emitChunk, { type: "tool_call", name: toolName, accordion: accordionHtml });
}

/** Queue of messages that arrived during agent run (Telegram, Email, Calendar, user input). Flushed to tool results or as user message when agent completes. */
const agentInjectedQueue: string[] = [];
let agentRunActive = false;

export function setAgentRunActive(active: boolean): void {
  agentRunActive = active;
}

export function isAgentRunActive(): boolean {
  return agentRunActive;
}

export function addToAgentInjectedQueue(msg: string): void {
  const trimmed = msg?.trim();
  if (trimmed) agentInjectedQueue.push(trimmed);
}

export function clearAgentInjectedQueue(): void {
  agentInjectedQueue.length = 0;
}

export function setPendingInjectMessage(msg: string | null): void {
  if (msg?.trim()) agentInjectedQueue.push(msg.trim());
}

export function getAndClearAgentInjectedQueue(): string[] {
  const out = [...agentInjectedQueue];
  agentInjectedQueue.length = 0;
  return out;
}

export function hasAgentInjectedMessages(): boolean {
  return agentInjectedQueue.length > 0;
}

function formatInjectedSection(messages: string[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map((m) => {
    if (m.startsWith("{")) {
      try {
        const p = JSON.parse(m) as { content?: string; user_name?: string; bus_id?: string; mail_uid?: number };
        const busId = p.bus_id ?? "root";
        let content = p.content ?? m;
        if (p.mail_uid != null) content += `\n\n[IMAP UID: ${p.mail_uid}]`;
        return `${busId}:${content}`;
      } catch {
        return m;
      }
    }
    if (m.includes(":") && !m.startsWith("{")) return m;
    return m;
  });
  return `\n\n--- Messages received during task execution. Reply to each on its bus_id (prefix with bus_id: — mandatory). You may reply to multiple buses in one turn. ---\n${lines.join("\n\n")}\n--- End ---`;
}

function maybeInjectUserMessage(
  resultText: string,
  _toolName: string,
  emitChunk?: (chunk: string) => void
): string {
  const queued = getAndClearAgentInjectedQueue();
  if (queued.length > 0) {
    const suffix = formatInjectedSection(queued);
    const flat = queued.join("\n\n");
    if (emitChunk) emitStructured(emitChunk, { type: "user_injected", content: flat });
    return resultText + suffix;
  }
  return resultText;
}

function getAndClearPendingInjectMessage(): string | null {
  const queued = getAndClearAgentInjectedQueue();
  if (queued.length === 0) return null;
  return queued.join("\n\n");
}

function parseQueuedToMessages(queued: string[]): { busId: string; content: string }[] {
  const result: { busId: string; content: string }[] = [];
  for (const m of queued) {
    if (m.startsWith("{")) {
      try {
        const p = JSON.parse(m) as { content?: string; bus_id?: string; mail_uid?: number };
        const busId = p.bus_id ?? "root";
        let content = String(p.content ?? m);
        if (p.mail_uid != null) content += `\n\n[IMAP UID: ${p.mail_uid}]`;
        result.push({ busId, content });
      } catch {
        const parsed = parsePrefixedMessages(m);
        if (parsed.length > 0) for (const p of parsed) result.push({ busId: p.busId, content: p.content });
        else result.push({ busId: "root", content: m });
      }
    } else {
      const parsed = parsePrefixedMessages(m);
      if (parsed.length > 0) for (const p of parsed) result.push({ busId: p.busId, content: p.content });
      else result.push({ busId: "root", content: m });
    }
  }
  return result;
}

/** Returns queued injected messages (formatted + raw + parsed) and clears queue. For eval result. */
export function getAndClearInjectedMessages(): { formatted: string; raw: string; messages: { busId: string; content: string }[] } | null {
  const queued = getAndClearAgentInjectedQueue();
  if (queued.length === 0) return null;
  return {
    formatted: formatInjectedSection(queued),
    raw: queued.join("\n\n"),
    messages: parseQueuedToMessages(queued),
  };
}

export type AiProvider = "claude" | "openrouter" | "codex";

export interface AgentConfig {
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  codexModel: string;
}

let agentConfig: AgentConfig | null = null;

let agentAbortRequested = false;
let lastCodexReasoningEncrypted: string | undefined;

export function requestAgentAbort(): void {
  agentAbortRequested = true;
}

export async function startAgent(config: AgentConfig): Promise<void> {
  if (config.aiProvider === "claude" && !config.claudeApiKey?.trim()) {
    throw new Error("Claude API key is required");
  }
  if (config.aiProvider === "openrouter" && !config.openrouterApiKey?.trim()) {
    throw new Error("OpenRouter API key is required");
  }
  if (config.aiProvider === "codex") {
    const { loadCodexAuth } = await import("../codex-auth.js");
    if (!loadCodexAuth()?.access) {
      throw new Error("Codex not authenticated. Click 'Login with ChatGPT' in Configuration.");
    }
  }

  agentConfig = config;
  const g = globalThis as {
    __yaaiaClaudeApiKey?: string;
    __yaaiaOpenRouterApiKey?: string;
    __yaaiaOpenRouterModel?: string;
  };
  g.__yaaiaClaudeApiKey = undefined;
  g.__yaaiaOpenRouterApiKey = undefined;
  g.__yaaiaOpenRouterModel = undefined;
  if (config.aiProvider === "claude") {
    g.__yaaiaClaudeApiKey = config.claudeApiKey;
  } else if (config.aiProvider === "openrouter") {
    g.__yaaiaOpenRouterApiKey = config.openrouterApiKey;
    g.__yaaiaOpenRouterModel = config.openrouterModel;
  }

  console.log("[YAAIA Agent] Ready (code-based, bbtag)");
}

export function stopAgent(): void {
  agentConfig = null;
}

export type StreamChunkCallback = (chunk: string) => void;
export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  /** messages.id — model history block only, not a separate stored turn */
  db_id?: number;
  timestamp?: string;
  bus_id?: string;
};

/** In-memory API transcript for the current chat session (cleared on start/stop chat). First request uses synthetic HISTORY; later requests reuse this as normal user/assistant turns. */
export type SessionApiMessage = { role: "user" | "assistant"; content: string };

let agentSessionApiMessages: SessionApiMessage[] = [];

export function clearAgentSessionApiMessages(): void {
  agentSessionApiMessages = [];
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type OpenAIMessage =
  | { role: "user" | "assistant" | "system"; content: string }
  | { role: "assistant"; content: null; tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; content: string; tool_call_id: string };

/** Prior DB snapshot for first-turn synthetic HISTORY only (must match getRootLog default). */
const MODEL_HISTORY_MAX_CHARS = 50_000;
/** Rolling cap on in-memory session transcript (user/assistant turns after first request). */
const SESSION_ROLLING_MAX_CHARS = 200_000;

/** Keep newest messages; drop/truncate oldest so total content length ≤ maxChars. First remaining turn must be user when possible. */
function trimSessionToRollingCharLimit(messages: SessionApiMessage[], maxChars: number): SessionApiMessage[] {
  if (messages.length === 0 || maxChars <= 0) return [];
  const out: SessionApiMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const len = m.content.length;
    if (len === 0) {
      out.unshift({ role: m.role, content: m.content });
      continue;
    }
    if (total + len <= maxChars) {
      out.unshift({ role: m.role, content: m.content });
      total += len;
    } else {
      const remaining = maxChars - total;
      if (remaining > 0) {
        out.unshift({ role: m.role, content: m.content.slice(-remaining) });
      }
      break;
    }
  }
  while (out.length > 0 && out[0].role === "assistant") {
    out.shift();
  }
  return out;
}

function formatHistoryLineForModel(h: HistoryMessage): string {
  const idPart = h.db_id != null ? String(h.db_id) : "?";
  const datePart = h.timestamp ?? "";
  const text = h.content.replace(/\r\n/g, "\n").replace(/\n+/g, " ").trim();
  return `${idPart} - ${datePart} - ${text}`;
}

function buildSyntheticHistoryUserContent(
  userMessage: string,
  history: HistoryMessage[],
  trimmedCount?: number
): string {
  const trimmedNote =
    trimmedCount !== undefined && trimmedCount > 0
      ? `Note: ${trimmedCount} earlier message(s) were omitted from this window (about ${MODEL_HISTORY_MAX_CHARS} characters). Use bus.get_history(bus_id="root", limit=50, offset=…) or optional from_timestamp, to_timestamp, from_id (SQLite messages.id) to fetch older messages if needed.\n\n`
      : "";
  if (history.length === 0) {
    return trimmedNote ? `${trimmedNote}${userMessage}` : userMessage;
  }
  const lines = history.map(formatHistoryLineForModel);
  const block = [
    "=== HISTORY (db_id - date - message) ===",
    ...lines,
    "=== HISTORY END ===",
    "",
    userMessage,
  ].join("\n");
  return trimmedNote ? `${trimmedNote}${block}` : block;
}

function buildUserMessagesWithTag(
  userMessage: string,
  history: HistoryMessage[],
  _targetBusId?: string,
  trimmedCount?: number
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const combined = buildSyntheticHistoryUserContent(userMessage, history, trimmedCount);
  messages.push({ role: "user" as const, content: combined });
  return messages;
}

/** Merge consecutive same-role messages. API-only, not stored. No synthetic "continue" — eval results are passed as user. */
function prepareMessagesForApi(messages: { role: string; content: string }[]): { role: "user" | "assistant"; content: string }[] {
  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const role = m.role as "user" | "assistant";
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content = last.content + (last.content ? "\n\n" : "") + m.content;
    } else {
      merged.push({ role, content: m.content });
    }
  }
  return merged;
}

async function runCodeBasedSendMessage(
  userMessage: string,
  onChunk?: StreamChunkCallback,
  history: HistoryMessage[] = [],
  targetBusId?: string,
  trimmedCount?: number,
  useOpenRouter = false,
  useCodex = false,
  sessionPrefix?: SessionApiMessage[],
  sendOptions?: { triggeringUserDbId?: number }
): Promise<{ text: string }> {
  const provider = useCodex ? "Codex" : useOpenRouter ? "OpenRouter" : "Claude";
  logVerbose("runCodeBasedSendMessage starting, provider:", provider, "user message length:", userMessage.length);

  const systemPrompt = loadSystemPrompt();
  const rawEmitChunk = (chunk: string) => {
    if (chunk && onChunk) onChunk(chunk);
  };

  const emitChunk = rawEmitChunk;

  type Message = { role: "user" | "assistant"; content: string };
  const messages: Message[] =
    sessionPrefix && sessionPrefix.length > 0
      ? [...sessionPrefix.map((m) => ({ ...m })), { role: "user", content: userMessage }]
      : (buildUserMessagesWithTag(userMessage, history, targetBusId, trimmedCount) as Message[]);

  if (!routeCallbacksForEval) {
    throw new Error("Route callbacks for eval not set. Ensure start-chat has run.");
  }

  const routeCallbacks: AgentApiRouteCallbacks = {
    ...routeCallbacksForEval,
    emitChunk,
  };

  try {
    let loopIter = 0;
    while (true) {
      loopIter++;
      if (process.env.DEBUG?.includes("yaaia") && loopIter > 1) logVerbose("Agent loop iteration", loopIter);
      if (agentAbortRequested) return { text: "Stopped by user." };

      const injected = getAndClearPendingInjectMessage();
      if (injected) {
        const last = messages[messages.length - 1];
        const wrapUser = "[User message during reply]: " + injected;
        if (last?.role === "assistant") {
          messages.push({ role: "user", content: wrapUser });
        } else {
          messages.push({ role: "assistant", content: "" });
          messages.push({ role: "user", content: wrapUser });
        }
        emitStructured(emitChunk, { type: "user_injected", content: injected });
        continue;
      }

      const streamHandler = createStreamHandler({ emitChunk: rawEmitChunk });
      const processChunk = (chunk: string) => {
        try {
          streamHandler.processChunk(chunk);
        } catch (e) {
          console.error("[YAAIA] Stream chunk error:", e);
        }
      };
      emitStructured(emitChunk, { type: "thinking" });
      let responseText: string;
      if (useCodex) {
        logVerbose("Calling Codex API, model:", agentConfig!.codexModel || "gpt-5.4-codex");
        const codexMessages = prepareMessagesForApi(messages);
        const result = await callCodexApi(
          systemPrompt,
          codexMessages,
          agentConfig!.codexModel || "gpt-5.4-codex",
          lastCodexReasoningEncrypted,
          (chunk) => processChunk(chunk)
        );
        streamHandler.flush();
        responseText = result.text;
        lastCodexReasoningEncrypted = result.reasoningEncrypted;
        logVerbose("Codex response received, length:", responseText.length);
      } else if (useOpenRouter) {
        const model = agentConfig!.openrouterModel || "google/gemini-2.5-flash";
        logVerbose("Calling OpenRouter API, model:", model);
        const apiKey = agentConfig!.openrouterApiKey.trim();
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: systemPrompt }, ...prepareMessagesForApi(messages)],
            max_tokens: 8192,
            stream: true,
            reasoning: { enabled: true },
          }),
        });
        logVerbose("OpenRouter response status:", res.status, res.statusText);
        if (!res.ok) throw new Error((await res.text()) || `OpenRouter API error ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("OpenRouter response has no body");
        const decoder = new TextDecoder();
        let buffer = "";
        responseText = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
              const choice = parsed.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta ?? choice.message;
              const content = delta?.content;
              if (typeof content === "string") {
                responseText += content;
                processChunk(content);
              }
            } catch {
              /* skip malformed */
            }
          }
        }
        streamHandler.flush();
        logVerbose("OpenRouter response received, content length:", responseText.length);
      } else {
        logVerbose("Calling Claude API, model:", agentConfig!.claudeModel || "claude-sonnet-4-6");
        const apiKey = (globalThis as { __yaaiaClaudeApiKey?: string }).__yaaiaClaudeApiKey;
        if (!apiKey) throw new Error("Claude API key not set.");
        const client = new Anthropic({ apiKey });
        const stream = client.messages.stream(
          {
            model: agentConfig!.claudeModel || "claude-sonnet-4-6",
            max_tokens: 16384,
            system: systemPrompt,
            messages: prepareMessagesForApi(messages) as Anthropic.MessageParam[],
            cache_control: { type: "ephemeral" },
            thinking: { type: "adaptive" },
          },
          { headers: { "anthropic-beta": "context-1m-2025-08-07" } }
        );
        stream.on("text", (delta) => processChunk(delta));
        const message = await stream.finalMessage();
        streamHandler.flush();
        const textBlock = message.content.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
        responseText = textBlock?.text ?? "";
        logVerbose("Claude response received, length:", responseText.length);
      }

      const fullText = responseText.trim();
      const { blocks } = extractBlocks(fullText, getCodeBoundary());
      const streamedMsgs = streamHandler.getStreamedMessages();
      const assistantDbIdForMemory =
        streamedMsgs.length > 0 ? streamedMsgs[streamedMsgs.length - 1]!.db_id : undefined;
      const memoryBuffers = createMemoryEvalBuffers();
      const hasTs = blocks.some((b) => b.type === "ts");
      const hasVmBash = blocks.some((b) => b.type === "vm-bash");

      if (!hasTs && hasVmBash) {
        messages.push({ role: "assistant", content: fullText });
        const errMsg =
          "Error: Your reply included vm-bash block(s) but no TypeScript block. vm-bash output is only available to the following TypeScript block via vmEvalStdout and vmEvalStderr. Include at least one `[…=ts]`…`[/…]` block in document order after each vm-bash segment (bash → ts → bash → ts). Repeat the assistant message with a TypeScript block that processes the vm shell output.";
        messages.push({ role: "user", content: errMsg });
        emitStructured(emitChunk, { type: "user_injected", content: errMsg });
        continue;
      }

      if (!hasTs) {
        const fromTime = streamedMsgs[0]?.streamingStart ?? new Date().toISOString();
        const toTime = streamedMsgs[streamedMsgs.length - 1]?.streamingEnd ?? new Date().toISOString();
        const external = getMessagesInWindow(fromTime, toTime, false, "user");
        if (external.length === 0) {
          messages.push({ role: "assistant", content: fullText });
          return { text: fullText || "" };
        }
        messages.push({ role: "assistant", content: fullText });
        const wrapUser = external.map((m) => m.content).join("\n\n");
        messages.push({ role: "user", content: wrapUser });
        emitStructured(emitChunk, { type: "user_injected", content: external.map((m) => m.content).join("\n\n") });
        continue;
      }

      // Run blocks sequentially: bash1 -> ts1 -> bash2 -> ts2 as they appear
      let evalResult: Awaited<ReturnType<typeof runAgentCode>> | null = null;
      for (const block of blocks) {
        if (block.type === "vm-bash") {
          const entry = sendVmScript(block.script, block.user);
          if (entry) {
            await entry.waitOrTimeout(block.timeout);
            appendVmEval(entry.stdout, entry.stderr, block.user);
          } else {
            const errMsg = "VM not connected, it may be powered off";
            appendVmEval(errMsg, errMsg, block.user);
          }
        } else {
          logVerbose("Running ts eval, code length:", block.code.length);
          if (process.env.DEBUG?.includes("yaaia")) {
            const stdoutBufs = getVmEvalStdout();
            const rootOut = stdoutBufs.root ?? "";
            console.log("[YAAIA vm-bash] vmEvalStdout keys=", Object.keys(stdoutBufs), "root len=", rootOut.length, "root tail=", JSON.stringify(rootOut.slice(-500)));
          }
          evalResult = await runAgentCode(block.code, {
            routeCallbacks,
            getInjectedMessages: getAndClearInjectedMessages,
            vmEvalStdout: getVmEvalStdout(),
            vmEvalStderr: getVmEvalStderr(),
            memoryEval: {
              buffers: memoryBuffers,
              assistantDbId: assistantDbIdForMemory,
              triggeringUserDbId: sendOptions?.triggeringUserDbId,
            },
          });
        }
      }
      const evalEndTime = new Date().toISOString();
      if (!evalResult) evalResult = { ok: true, output: "", injected: undefined, askUserReply: undefined };

      if (
        assistantDbIdForMemory != null &&
        assistantDbIdForMemory >= 1 &&
        memoryBuffers.pending.length > 0
      ) {
        flushPendingMemoryRows(getHistoryDb(), memoryBuffers, assistantDbIdForMemory);
      }

      const outputText = evalResult.ok
        ? evalResult.output
        : `Error: ${evalResult.error}`;

      logVerbose("Eval finished, ok:", evalResult.ok, "output length:", outputText.length);

      if (evalResult.vmPowerOnAbort) {
        return { text: outputText.trim() };
      }

      const fromTime = streamedMsgs[0]?.streamingStart ?? new Date().toISOString();
      const streamEndTime = streamedMsgs[streamedMsgs.length - 1]?.streamingEnd ?? fromTime;
      const toTime = streamEndTime > evalEndTime ? streamEndTime : evalEndTime;
      const external = getMessagesInWindow(fromTime, toTime, false, "user");

      if (evalResult.injected) {
        emitStructured(emitChunk, { type: "user_injected", content: evalResult.injected.raw });
      }
      if (evalResult.askUserReply != null) {
        emitStructured(emitChunk, { type: "user_injected", content: evalResult.askUserReply });
      }

      if (!evalResult.ok && outputText.trim()) {
        const errContent = `root:${outputText.trim()}`;
        appendMessage(ROOT_BUS_ID, { role: "user", content: errContent, during_eval: true });
        const { deliverMessage } = await import("../message-delivery.js");
        deliverMessage(ROOT_BUS_ID, errContent).catch(() => { });
        emitChunk(errContent + "\n");
      }

      const parsedOutput = parsePrefixedMessages(outputText);
      const evalUserParts: string[] = [];
      for (const msg of parsedOutput) {
        evalUserParts.push(`${msg.busId}:${msg.content}`);
      }
      if (parsedOutput.length === 0 && outputText.trim()) {
        evalUserParts.push(`root:${outputText.trim()}`);
      }
      const injectedMessages = (evalResult.injected as { messages?: { busId: string; content: string }[] } | undefined)?.messages;
      if (injectedMessages) {
        for (const { busId, content } of injectedMessages) {
          evalUserParts.push(`${busId}:${content}`);
        }
      }
      if (evalResult.askUserReply != null && evalResult.askUserReply.trim()) {
        evalUserParts.push(evalResult.askUserReply.trim());
      }
      if (external.length > 0) {
        const externalParts = external.map((m) => m.content);
        evalUserParts.push(...externalParts);
      }
      if (evalUserParts.length === 0) {
        return { text: outputText.trim() || fullText };
      }
      messages.push({ role: "assistant", content: fullText });
      const wrapUser = evalUserParts.join("\n\n");
      messages.push({ role: "user", content: wrapUser });

      if (!fullText.trim()) return { text: fullText };
    }
  } finally {
    const snapshot = messages.map((m) => ({ role: m.role, content: m.content }));
    agentSessionApiMessages = trimSessionToRollingCharLimit(snapshot, SESSION_ROLLING_MAX_CHARS);
  }
}

export async function sendMessage(
  userMessage: string,
  onChunk?: StreamChunkCallback,
  history: HistoryMessage[] = [],
  targetBusId?: string,
  trimmedCount?: number,
  sendOptions?: { triggeringUserDbId?: number }
): Promise<{ text: string }> {
  logVerbose("sendMessage called, provider:", agentConfig?.aiProvider ?? "?", "targetBusId:", targetBusId ?? "root");
  if (!agentConfig) {
    throw new Error("Agent not started. Add API key and click Start chat.");
  }

  agentAbortRequested = false;

  const useSessionContinuation = agentSessionApiMessages.length > 0;
  return runCodeBasedSendMessage(
    userMessage,
    onChunk,
    useSessionContinuation ? [] : history,
    targetBusId,
    useSessionContinuation ? 0 : trimmedCount,
    agentConfig.aiProvider === "openrouter",
    agentConfig.aiProvider === "codex",
    useSessionContinuation ? agentSessionApiMessages : undefined,
    sendOptions
  );
}
