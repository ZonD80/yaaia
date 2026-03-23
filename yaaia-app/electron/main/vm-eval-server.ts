/**
 * WebSocket server for VM eval. VM agent connects, receives scripts, runs them,
 * streams stdout/stderr, supports stdin for interactive prompts.
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const VM_EVAL_PORT = 29542;

export interface VmEvalEntry {
  stdout: string;
  stderr: string;
  exitCode?: number;
  done: boolean;
  /** Resolves when script completes. */
  wait: () => Promise<void>;
  /** Resolves when done OR after seconds. Use for non-blocking: always get control back. */
  waitOrTimeout: (seconds: number) => Promise<void>;
  sendStdin: (data: string) => void;
}

let vmEvalServer: ReturnType<typeof createServer> | null = null;
let vmSocket: InstanceType<typeof WebSocketServer extends { new(...args: unknown[]): infer R } ? R : never> | null = null;
let wsClient: { send: (data: string | Buffer) => void; readyState: number } | null = null;

let onVmConnected: (() => void) | null = null;

/** Persistent vm-bash output buffers per user. Key: "root" or user_id. Cleared only on stop-chat. */
const vmEvalStdoutByUser: Record<string, string> = {};
const vmEvalStderrByUser: Record<string, string> = {};

export function appendVmEval(stdout: string, stderr: string, user: string): void {
  const key = user || "root";
  if (!vmEvalStdoutByUser[key]) vmEvalStdoutByUser[key] = "";
  if (!vmEvalStderrByUser[key]) vmEvalStderrByUser[key] = "";
  vmEvalStdoutByUser[key] += stdout;
  vmEvalStderrByUser[key] += stderr;
}

/** Returns Record<user, stdout> e.g. { root: string, "1000": string }. */
export function getVmEvalStdout(): Record<string, string> {
  return { ...vmEvalStdoutByUser };
}

/** Returns Record<user, stderr> e.g. { root: string, "1000": string }. */
export function getVmEvalStderr(): Record<string, string> {
  return { ...vmEvalStderrByUser };
}

export function clearVmEvalBuffer(): void {
  for (const k of Object.keys(vmEvalStdoutByUser)) delete vmEvalStdoutByUser[k];
  for (const k of Object.keys(vmEvalStderrByUser)) delete vmEvalStderrByUser[k];
}

/** Called when VM agent connects. Main process wires this to queue/send "root:VM connected for vm-bash execution". */
export function setOnVmConnected(cb: (() => void) | null): void {
  onVmConnected = cb;
}

const WS_OPEN = 1;

export function isVmEvalConnected(): boolean {
  return wsClient != null && wsClient.readyState === WS_OPEN;
}

export function startVmEvalServer(): void {
  if (vmEvalServer) return;
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/vm-eval") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    if (wsClient) wsClient = null;
    wsClient = ws as typeof wsClient;
    if (process.env.DEBUG?.includes("yaaia")) {
      console.log("[YAAIA vm-eval] VM connected");
    }
    onVmConnected?.();
    ws.on("message", (raw: Buffer | string) => {
      const data = raw.toString();
      let msg: { type?: string; id?: string; stdout?: string; stderr?: string; exitCode?: number; stream?: string; data?: string };
      try {
        msg = JSON.parse(data);
      } catch (e) {
        console.warn("[YAAIA vm-eval] Invalid JSON:", data.slice(0, 100));
        return;
      }
      const id = msg.id;
      if (process.env.DEBUG?.includes("yaaia")) {
        console.log("[YAAIA vm-eval] Recv", msg.type, id);
      }
      if (!id) return;
      const pending = pendingById.get(id);
      if (!pending) {
        if (process.env.DEBUG?.includes("yaaia")) {
          console.log("[YAAIA vm-eval] No pending for id", id, "known:", [...pendingById.keys()]);
        }
        return;
      }

      if (msg.type === "stream") {
        if (msg.stream === "stdout" && msg.data != null) {
          const decoded = Buffer.from(msg.data, "base64").toString("utf-8");
          pending.entry.stdout += decoded;
          if (process.env.DEBUG?.includes("yaaia")) {
            console.log("[YAAIA vm-eval] stdout chunk id=", id, "len=", decoded.length);
          }
        } else if (msg.stream === "stderr" && msg.data != null) {
          pending.entry.stderr += Buffer.from(msg.data, "base64").toString("utf-8");
        }
      } else if (msg.type === "result") {
        if (msg.stdout != null) {
          pending.entry.stdout = Buffer.from(msg.stdout, "base64").toString("utf-8");
        }
        if (msg.stderr != null) {
          pending.entry.stderr = Buffer.from(msg.stderr, "base64").toString("utf-8");
        }
        if (msg.exitCode != null) pending.entry.exitCode = msg.exitCode;
        pending.entry.done = true;
        pendingById.delete(id);
        if (process.env.DEBUG?.includes("yaaia")) {
          console.log("[YAAIA vm-eval] Result for", id, "stdout len=", msg.stdout?.length ?? 0, "stdout=", JSON.stringify((msg.stdout ?? "").slice(0, 200)));
        }
        // setImmediate so vm context's await continuation runs in next tick
        const resolve = pending.resolve;
        setImmediate(() => resolve());
      }
    });
    ws.on("close", () => {
      if (wsClient === ws) wsClient = null;
      if (process.env.DEBUG?.includes("yaaia")) {
        console.log("[YAAIA vm-eval] VM disconnected");
      }
    });
    ws.on("error", () => {
      if (wsClient === ws) wsClient = null;
    });
  });

  server.listen(VM_EVAL_PORT, "0.0.0.0", () => {
    if (process.env.DEBUG?.includes("yaaia")) {
      console.log("[YAAIA vm-eval] Server listening on 0.0.0.0:" + VM_EVAL_PORT);
    }
  });
  vmEvalServer = server;
  vmSocket = wss as unknown as typeof vmSocket;
}

export function stopVmEvalServer(): void {
  if (vmEvalServer) {
    vmEvalServer.close();
    vmEvalServer = null;
  }
  vmSocket = null;
  wsClient = null;
  clearVmEvalBuffer();
}

const pendingById = new Map<
  string,
  {
    resolve: () => void;
    entry: VmEvalEntry;
    stdinCh: (data: string) => void;
  }
>();

function createEntry(): VmEvalEntry {
  let resolveWait: () => void;
  const waitPromise = new Promise<void>((r) => {
    resolveWait = r;
  });
  const stdinQueue: string[] = [];
  let stdinConsumer: ((data: string) => void) | null = null;

  const entry: VmEvalEntry = {
    stdout: "",
    stderr: "",
    done: false,
    wait: () => waitPromise,
    waitOrTimeout: (seconds: number) =>
      Promise.race([
        waitPromise,
        new Promise<void>((r) => setTimeout(r, Math.max(0, seconds) * 1000)),
      ]),
    sendStdin: (data: string) => {
      if (stdinConsumer) {
        stdinConsumer(data);
      } else {
        stdinQueue.push(data);
      }
    },
  };

  (entry as { _resolve: () => void })._resolve = () => {
    resolveWait();
  };
  (entry as { _setStdinConsumer: (cb: (d: string) => void) => void })._setStdinConsumer = (cb: (d: string) => void) => {
    stdinConsumer = cb;
    for (const d of stdinQueue) cb(d);
    stdinQueue.length = 0;
  };

  return entry;
}

export function sendVmScript(script: string, user: string): VmEvalEntry | null {
  if (!wsClient || wsClient.readyState !== WS_OPEN) return null;
  const id = `vm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const entry = createEntry();
  const resolve = (entry as { _resolve: () => void })._resolve;
  const setStdinConsumer = (entry as { _setStdinConsumer: (cb: (d: string) => void) => void })._setStdinConsumer;

  pendingById.set(id, {
    resolve,
    entry,
    stdinCh: (data) => {
      if (wsClient?.readyState === WS_OPEN) {
        wsClient.send(JSON.stringify({ type: "stdin", id, data }));
      }
    },
  });
  setStdinConsumer((data) => {
    pendingById.get(id)?.stdinCh(data);
  });

  if (process.env.DEBUG?.includes("yaaia")) {
    console.log("[YAAIA vm-eval] Sending script id=", id, "len=", script.length, "user=", user);
  }
  wsClient.send(JSON.stringify({ type: "script", id, script, user }));
  return entry;
}
