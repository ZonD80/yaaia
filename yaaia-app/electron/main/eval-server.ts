/**
 * Eval-only MCP server. Single tool: eval — runs TypeScript code.
 * All API (kb, fs, mail, caldav, etc.) is available inside the eval runtime via direct-tools.
 */

import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServerConfig } from "./mcp-server/config.js";
import { runAgentCode } from "./agent-eval.js";
import { ensureStorageDirs, kbEnsureCollection } from "./mcp-server/kb-client.js";

function toolResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function ensureStorageReady(): void {
  ensureStorageDirs();
  kbEnsureCollection("history");
}

async function createEvalMcpServer(config: McpServerConfig): Promise<McpServer> {
  config.onStartupProgress?.("Preparing storage...");
  ensureStorageReady();
  config.onStartupProgress?.("Ready");

  const server = new McpServer(
    { name: "yaaia-eval", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "eval",
    {
      description: "Run TypeScript code in an isolated runtime. Has access to kb, fs, mail, caldav, send_message, ask, passwords.*, etc. All functions return Promise<string>. Use send_message for progress. Prefix format: bus_id:content or bus_id:wait:content.",
      inputSchema: z.object({
        code: z.string().describe("TypeScript code to execute. Use await for async calls."),
      }),
    },
    async (args) => {
      const code = String((args as { code?: string }).code ?? "").trim();
      if (!code) {
        return toolResult("Error: code is required");
      }
      try {
        const result = await runAgentCode(code, {});
        const output = result.ok ? result.output : `Error: ${result.error}`;
        return toolResult(output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolResult(`Error: ${msg}`);
      }
    }
  );

  return server;
}

export async function startEvalMcpServer(config: McpServerConfig): Promise<Server> {
  const transports: Record<string, SSEServerTransport> = {};
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/sse", async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    const mcpServer = await createEvalMcpServer(config);
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
      console.log(`[YAAIA Eval] Listening on port ${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

export function getEvalServerPort(server: Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr?.port ? addr.port : 0;
}

/** No-op. KB/FS no longer use MCP subprocesses. */
export async function stopKbMcp(): Promise<void> {}

/** No-op. KB/FS no longer use MCP subprocesses. */
export async function stopFsMcp(): Promise<void> {}
