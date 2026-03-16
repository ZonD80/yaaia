/**
 * Codex API client for ChatGPT Plus/Pro (Codex) backend.
 * Uses OAuth tokens from codex-auth.ts.
 */

import {
  loadCodexAuth,
  refreshCodexToken,
  getCodexAccountId,
  isCodexTokenExpired,
} from "./codex-auth.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`;

type CodexInputItem =
  | { type: "message"; role: "developer" | "user" | "assistant"; content: { type: "input_text"; text: string }[] }
  | { type: "message"; role: "developer" | "user" | "assistant"; content: { type: "input_text"; text: string }[]; reasoning?: { encrypted_content?: string } };

function toCodexInputItem(role: "developer" | "user" | "assistant", content: string, reasoningEncrypted?: string): CodexInputItem {
  const item: CodexInputItem = {
    type: "message",
    role,
    content: [{ type: "input_text", text: content }],
  };
  if (reasoningEncrypted && role === "assistant") {
    (item as CodexInputItem & { reasoning?: { encrypted_content?: string } }).reasoning = {
      encrypted_content: reasoningEncrypted,
    };
  }
  return item;
}

export type CodexMessage = { role: "user" | "assistant"; content: string };

function buildCodexInput(messages: CodexMessage[], lastReasoningEncrypted?: string): CodexInputItem[] {
  const input: CodexInputItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role === "user" ? "user" : "assistant";
    const encrypted = role === "assistant" && i === messages.length - 1 ? lastReasoningEncrypted : undefined;
    input.push(toCodexInputItem(role, m.content, encrypted));
  }
  return input;
}

function normalizeModel(model: string): string {
  const m = (model || "gpt-5.4-codex").toLowerCase();
  if (m.includes("gpt-5.4-codex")) return "gpt-5.4-codex";
  if (m.includes("gpt-5.2-codex")) return "gpt-5.2-codex";
  if (m.includes("gpt-5.1-codex-max")) return "gpt-5.1-codex-max";
  if (m.includes("gpt-5.1-codex-mini")) return "gpt-5.1-codex-mini";
  if (m.includes("gpt-5.1-codex") || m.includes("codex")) return "gpt-5.1-codex";
  if (m.includes("gpt-5.2")) return "gpt-5.2";
  if (m.includes("gpt-5.1")) return "gpt-5.1";
  return "gpt-5.4-codex";
}

/** Parse SSE stream: text from response.output_text.delta, reasoning from response.done. Emits deltas via onChunk. */
async function parseCodexSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  onChunk?: (chunk: string) => void
): Promise<{ text: string; reasoningEncrypted?: string }> {
  let buffer = "";
  let fullContent = "";
  let reasoningEncrypted: string | undefined;
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
        const parsed = JSON.parse(data) as {
          type?: string;
          delta?: string;
          response?: { reasoning?: { encrypted_content?: string } };
        };
        if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
          fullContent += parsed.delta;
          onChunk?.(parsed.delta);
        }
        if (parsed.type === "response.done" || parsed.type === "response.completed") {
          const r = parsed.response;
          if (r?.reasoning?.encrypted_content) {
            reasoningEncrypted = r.reasoning.encrypted_content;
          }
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return { text: fullContent, reasoningEncrypted };
}

export async function callCodexApi(
  systemPrompt: string,
  messages: CodexMessage[],
  model: string,
  lastReasoningEncrypted?: string,
  onChunk?: (chunk: string) => void
): Promise<{ text: string; reasoningEncrypted?: string }> {
  let auth = loadCodexAuth();
  if (!auth?.access) {
    throw new Error("Codex not authenticated. Click 'Login with ChatGPT' in Configuration.");
  }
  if (isCodexTokenExpired()) {
    const refreshed = await refreshCodexToken();
    if (!refreshed) throw new Error("Codex token expired. Please log in again.");
    auth = refreshed;
  }
  const accountId = getCodexAccountId();
  if (!accountId) {
    throw new Error("Could not extract ChatGPT account ID from token. Please log in again.");
  }

  const input = buildCodexInput(messages, lastReasoningEncrypted);
  const normalizedModel = normalizeModel(model);

  if (process.env.DEBUG?.includes("yaaia")) {
    console.log("[YAAIA Codex] POST", CODEX_RESPONSES_URL, "model:", normalizedModel, "messages:", messages.length);
  }

  const body = {
    model: normalizedModel,
    store: false,
    stream: true,
    instructions: systemPrompt,
    input,
    reasoning: { effort: "medium" as const, summary: "auto" as const },
    text: { verbosity: "medium" as const },
    include: ["reasoning.encrypted_content"],
  };

  const res = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error("Codex authentication expired. Please log in again.");
    }
    if (res.status === 404 && /usage_limit|usage_not_included|rate_limit/i.test(text)) {
      throw new Error("Codex usage limit reached. Check your ChatGPT subscription limits (5h/weekly windows).");
    }
    throw new Error(`Codex API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Codex response has no body");
  const decoder = new TextDecoder();
  const { text, reasoningEncrypted: re } = await parseCodexSseStream(reader, decoder, onChunk);
  if (process.env.DEBUG?.includes("yaaia")) {
    console.log("[YAAIA Codex] Response received, text length:", text.length);
  }
  return { text, reasoningEncrypted: re };
}
