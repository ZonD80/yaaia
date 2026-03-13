/**
 * MCP client that connects to @cyanheads/filesystem-mcp-server subprocess via stdio.
 * Scoped to ~/yaaia/downloads. Server logs to its package ./logs (LOGS_DIR must be inside package).
 */

import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const YAAIA_DIR = join(homedir(), "yaaia");
const FS_BASE_DIRECTORY = join(YAAIA_DIR, "downloads");
// Do NOT pass LOGS_DIR: filesystem-mcp-server requires it to be inside its project root (ensureDirectory check).
// It will use default ./logs in the package dir.

const FS_LOG = "[YAAIA FS]";

export interface FsTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

let fsClient: Client | null = null;
let fsTransport: StdioClientTransport | null = null;

export async function connectFsMcp(): Promise<void> {
  console.log(`${FS_LOG} connectFsMcp: starting`);
  if (fsClient) {
    console.log(`${FS_LOG} connectFsMcp: closing existing connection`);
    try {
      await fsClient.close();
    } catch (err) {
      console.warn(`${FS_LOG} connectFsMcp: close error:`, err instanceof Error ? err.message : String(err));
    }
    fsClient = null;
    fsTransport = null;
  }

  mkdirSync(FS_BASE_DIRECTORY, { recursive: true });

  const require = createRequire(import.meta.url);
  const fsMcpPath = require.resolve("@cyanheads/filesystem-mcp-server/dist/index.js");
  const fsMcpCwd = dirname(dirname(fsMcpPath)); // package root for findProjectRoot
  console.log(`${FS_LOG} connectFsMcp: spawn path=${fsMcpPath} cwd=${fsMcpCwd} FS_BASE_DIRECTORY=${FS_BASE_DIRECTORY}`);

  fsTransport = new StdioClientTransport({
    command: process.execPath,
    args: [fsMcpPath],
    cwd: fsMcpCwd,
    stderr: "pipe",
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: "stdio",
      FS_BASE_DIRECTORY,
      MCP_LOG_LEVEL: "warn",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  // Pipe subprocess stderr to our logs before connect
  const stderrStream = (fsTransport as { stderr?: { on: (ev: string, cb: (chunk: Buffer | string) => void) => void } }).stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer | string) => {
      const s = String(chunk).trim();
      if (s) console.warn(`${FS_LOG} stderr:`, s);
    });
  }

  fsClient = new Client(
    { name: "yaaia-fs-proxy", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await fsClient.connect(fsTransport);
    const pid = (fsTransport as { pid?: number }).pid;
    console.log(`${FS_LOG} connectFsMcp: connected pid=${pid ?? "?"}`);

    // Set default path to downloads so relative paths (e.g. "test.txt") resolve correctly
    await callFsTool("set_filesystem_default", { path: FS_BASE_DIRECTORY });
    console.log(`${FS_LOG} connectFsMcp: default path set to ${FS_BASE_DIRECTORY}`);
  } catch (err) {
    console.error(`${FS_LOG} connectFsMcp: connect failed:`, err instanceof Error ? err.message : String(err));
    fsClient = null;
    fsTransport = null;
    throw err;
  }
}

export async function disconnectFsMcp(): Promise<void> {
  console.log(`${FS_LOG} disconnectFsMcp: starting`);
  try {
    if (fsClient) {
      await fsClient.close();
      console.log(`${FS_LOG} disconnectFsMcp: closed`);
    }
  } catch (err) {
    console.warn(`${FS_LOG} disconnectFsMcp: error:`, err instanceof Error ? err.message : String(err));
  } finally {
    fsClient = null;
    fsTransport = null;
    console.log(`${FS_LOG} disconnectFsMcp: done`);
  }
}

export async function listFsTools(): Promise<FsTool[]> {
  if (!fsClient) throw new Error("FS MCP not connected");
  console.log(`${FS_LOG} listFsTools: calling`);
  try {
    const result = await fsClient.listTools();
    const tools = result.tools as FsTool[];
    console.log(`${FS_LOG} listFsTools: got ${tools.length} tools`);
    return tools;
  } catch (err) {
    console.error(`${FS_LOG} listFsTools: failed:`, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function callFsTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
  if (!fsClient) throw new Error("FS MCP not connected");
  console.log(`${FS_LOG} callFsTool: ${name}`, JSON.stringify(args));
  try {
    const result = await fsClient.callTool({ name, arguments: args });
    const text = (result as { content?: { type: string; text?: string }[] }).content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => (c as { text: string }).text)
      .join("\n")
      .slice(0, 200);
    console.log(`${FS_LOG} callFsTool result: ${name}`, result?.isError ? "ERROR" : "OK", text ? `"${text}${text.length >= 200 ? "..." : ""}"` : "");
    return result as { content: { type: string; text?: string }[]; isError?: boolean };
  } catch (err) {
    console.error(`${FS_LOG} callFsTool error: ${name}`, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
