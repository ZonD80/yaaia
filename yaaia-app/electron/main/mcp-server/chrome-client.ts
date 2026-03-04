/**
 * MCP client that connects to chrome-devtools-mcp subprocess via stdio.
 * Uses Electron's bundled Node (no system Node required).
 */

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCREENSHOT_TOOLS = new Set(["take_screenshot", "take_snapshot"]);

/** Tools that change the page; after success we auto-take a screenshot for the recipe only (not sent to agent). */
const PAGE_CHANGING_TOOLS = new Set([
  "navigate_page",
  "click",
  "click_at",
  "hover",
  "fill",
  "type_text",
  "drag",
  "fill_form",
  "upload_file",
  "press_key",
  "select_page",
  "resize_page",
  "new_page",
  "close_page",
  "handle_dialog",
]);

export interface ChromeTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

let chromeClient: Client | null = null;
let chromeTransport: StdioClientTransport | null = null;

export async function connectChromeMcp(browserUrl: string): Promise<void> {
  if (chromeClient) {
    await chromeClient.close();
    chromeClient = null;
    chromeTransport = null;
  }

  const require = createRequire(import.meta.url);
  const chromeMcpPath = require.resolve("chrome-devtools-mcp/build/src/index.js");
  chromeTransport = new StdioClientTransport({
    command: process.execPath,
    args: [chromeMcpPath, `--browser-url=${browserUrl}`, "--no-usage-statistics", "--category-extensions"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  chromeClient = new Client(
    { name: "yaaia-chrome-proxy", version: "1.0.0" },
    { capabilities: {} }
  );

  await chromeClient.connect(chromeTransport);
}

export async function disconnectChromeMcp(): Promise<void> {
  if (chromeTransport) {
    await chromeTransport.close();
    chromeTransport = null;
  }
  chromeClient = null;
}

export async function listChromeTools(): Promise<ChromeTool[]> {
  if (!chromeClient) throw new Error("Chrome MCP not connected");
  const result = await chromeClient.listTools();
  return result.tools as ChromeTool[];
}

export async function callChromeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
  if (!chromeClient) throw new Error("Chrome MCP not connected");
  console.log("[YAAIA Chrome] Tool call:", name, JSON.stringify(args));
  try {
    const result = await chromeClient.callTool({ name, arguments: args });
    const text = (result as { content?: { type: string; text?: string }[] }).content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => (c as { text: string }).text)
      .join("\n")
      .slice(0, 200);
    console.log("[YAAIA Chrome] Tool result:", name, result?.isError ? "ERROR" : "OK", text ? `"${text}${text.length >= 200 ? "..." : ""}"` : "");
    return result as { content: { type: string; text?: string }[]; isError?: boolean };
  } catch (err) {
    console.error("[YAAIA Chrome] Tool error:", name, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function isScreenshotTool(name: string): boolean {
  return SCREENSHOT_TOOLS.has(name);
}

export function isPageChangingTool(name: string): boolean {
  return PAGE_CHANGING_TOOLS.has(name);
}

/** Take a screenshot for recipe only. Returns base64 or undefined. Does not affect agent. */
export async function takeScreenshotForRecipe(): Promise<string | undefined> {
  try {
    const result = await callChromeTool("take_screenshot", {});
    return extractScreenshotFromResult(result);
  } catch {
    return undefined;
  }
}

export function extractScreenshotFromResult(
  result: { content: { type: string; text?: string }[] }
): string | undefined {
  for (const item of result.content ?? []) {
    if (item.type === "image" && "data" in item) {
      const img = item as { type: string; data?: string; mimeType?: string };
      return img.data;
    }
    if (item.type === "text" && typeof item.text === "string") {
      const t = item.text.trim();
      if (t.startsWith("data:image/") || /^[A-Za-z0-9+/=]+$/.test(t) && t.length > 100) {
        const base64 = t.includes(",") ? t.split(",")[1] : t;
        if (base64) return base64;
      }
    }
  }
  return undefined;
}
