/**
 * Eval runtime for agent-generated TypeScript code.
 * Uses Node vm module for isolation. Transpiles TS to JS via esbuild.
 * Captures stdout (console.log/info/debug), stderr (console.warn/error).
 * console.log('bus_id:content') is parsed and routed to buses; streams during execution.
 */

import vm from "node:vm";
import * as esbuild from "esbuild";
import type { AgentApiDeps } from "./agent-api.js";
import { createAgentApi } from "./agent-api.js";
import {
  createDirectCallTool,
  getDirectToolsAppConfig,
  getDirectToolsSetupMode,
  VmPowerOnAbortError,
} from "./direct-tools.js";
import { appendMessage, ensureBus, isValidBusId, ROOT_BUS_ID } from "./message-db.js";
import { deliverMessage } from "./message-delivery.js";
import { parsePrefixedMessages } from "./stream-handler.js";
import { waitForUserReply } from "./ask-user-bridge.js";
import { listVms } from "./vm-manager.js";
import { getGmailClient, getCalendarClient } from "./google-api-agent.js";

const EVAL_TIMEOUT_MS = 120_000;

/** Persistent eval context (reused across runs). Cleared on stop-chat. */
let persistentContext: vm.Context | null = null;
let persistentSandbox: Record<string, unknown> | null = null;

/** Clear the persistent eval context. Call on stop-chat. */
export function clearEvalContext(): void {
  persistentContext = null;
  persistentSandbox = null;
}

export interface EvalResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Queued messages (Telegram, email, CalDAV, etc.) received during eval. */
  injected?: { formatted: string; raw: string; messages?: { busId: string; content: string }[] };
  /** User reply from ask-user popup (bus_id:wait:content). */
  askUserReply?: string;
  /** vm.power_on abort in non-setup mode — do not trigger another model call. */
  vmPowerOnAbort?: boolean;
}

function formatArg(x: unknown): string {
  if (x === undefined) return "undefined";
  if (x === null) return "null";
  if (typeof x === "object" || typeof x === "function") {
    try {
      return JSON.stringify(x, null, 2);
    } catch {
      return String(x);
    }
  }
  return String(x);
}

type QueuedWait = { busId: string; content: string };

function createCapturingConsole(deps: AgentApiDeps): {
  console: Console;
  getOutput: () => string;
  drainQueuedRoutes: (skipAppendToQueue: boolean) => Promise<void>;
  getLastAskUserReply: () => string | undefined;
} {
  const { routeCallbacks } = deps;
  const chunks: { stream: "stdout" | "stderr"; text: string }[] = [];
  const queuedWaits: QueuedWait[] = [];

  const write = (stream: "stdout" | "stderr", args: unknown[]) => {
    const text = args.map(formatArg).join(" ").trimEnd();
    if (!text) return;
    const withNewline = text + "\n";
    chunks.push({ stream, text: withNewline });

    const toParse = stream === "stderr" ? `root:${text}` : text;
    const parsed = parsePrefixedMessages(toParse);
    if (parsed.length > 0) {
      for (const msg of parsed) {
        if (!isValidBusId(msg.busId)) continue;
        const storedContent = `${msg.busId}:${msg.content}`;
        if (msg.waitForAnswer && (msg.busId === ROOT_BUS_ID || msg.busId.startsWith("telegram-"))) {
          queuedWaits.push({ busId: msg.busId, content: msg.content });
          routeCallbacks.emitChunk?.(storedContent + "\n");
        } else {
          routeCallbacks.emitChunk?.(storedContent + "\n");
          ensureBus(msg.busId);
          appendMessage(msg.busId, { role: "user", content: storedContent, during_eval: true });
          deliverMessage(msg.busId, storedContent).catch((e) => console.warn("[YAAIA Eval] Delivery failed:", e));
        }
      }
    } else if (text.trim()) {
      const storedContent = `${ROOT_BUS_ID}:${text.trim()}`;
      routeCallbacks.emitChunk?.(storedContent + "\n");
      ensureBus(ROOT_BUS_ID);
      appendMessage(ROOT_BUS_ID, { role: "user", content: storedContent, during_eval: true });
      deliverMessage(ROOT_BUS_ID, storedContent).catch((e) => console.warn("[YAAIA Eval] Delivery failed:", e));
    }
  };

  const capturingConsole = {
    log: (...args: unknown[]) => write("stdout", args),
    info: (...args: unknown[]) => write("stdout", args),
    debug: (...args: unknown[]) => write("stdout", args),
    warn: (...args: unknown[]) => write("stderr", args),
    error: (...args: unknown[]) => write("stderr", args),
    trace: (...args: unknown[]) => write("stderr", ["Trace:", ...args]),
    dir: (obj: unknown) => write("stdout", [formatArg(obj)]),
    dirxml: (...args: unknown[]) => write("stdout", args),
    table: (data: unknown) =>
      write("stdout", [typeof data === "object" && data !== null ? JSON.stringify(data, null, 2) : formatArg(data)]),
    count: () => { },
    countReset: () => { },
    group: () => { },
    groupCollapsed: () => { },
    groupEnd: () => { },
    time: () => { },
    timeLog: () => { },
    timeEnd: () => { },
    assert: (value: unknown, ...args: unknown[]) => {
      if (!value) write("stderr", ["Assertion failed:", ...args]);
    },
    clear: () => { },
    profile: () => { },
    profileEnd: () => { },
    timeStamp: () => { },
  } as Console;

  const getOutput = (): string => chunks.map((c) => c.text).join("");

  let lastAskUserReply: string | undefined;
  const drainQueuedRoutes = async (skipAppendToQueue: boolean) => {
    lastAskUserReply = undefined;
    if (skipAppendToQueue || queuedWaits.length === 0) return;
    for (const { busId, content } of queuedWaits) {
      const storedContent = `${busId}:${content}`;
      ensureBus(busId);
      appendMessage(busId, { role: "user", content: storedContent, during_eval: true });
      deliverMessage(busId, storedContent).catch((e) => console.warn("[YAAIA Eval] Delivery failed:", e));
      routeCallbacks.onAskUserRequest?.({ clarification: content, assessment: "", attempt: 0 });
      const reply = await waitForUserReply({
        timeoutMs: 60_000,
        onTimeout: routeCallbacks.onAskUserTimeout,
        busId: busId !== ROOT_BUS_ID ? busId : undefined,
      });
      lastAskUserReply = reply;
      const replyContent = `${busId}:User replied: ${reply}`;
      appendMessage(busId, { role: "user", content: replyContent, during_eval: false });
      deliverMessage(busId, replyContent).catch(() => {});
      routeCallbacks.emitChunk?.(replyContent + "\n");
    }
    queuedWaits.length = 0;
  };

  const getLastAskUserReply = () => lastAskUserReply;

  return { console: capturingConsole, getOutput, drainQueuedRoutes, getLastAskUserReply };
}

export async function runAgentCode(
  code: string,
  deps: AgentApiDeps
): Promise<EvalResult> {
  if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Transpiling code, length:", code.length);
  let js: string;
  try {
    const transpiled = await esbuild.transform(code, {
      loader: "ts",
      target: "es2022",
      format: "esm",
    });
    js = transpiled.code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const error = `TypeScript error: ${msg}${stack ? `\n${stack}` : ""}`;
    return { ok: false, output: "", error };
  }

  const { console: capturingConsole, getOutput, drainQueuedRoutes, getLastAskUserReply } = createCapturingConsole(deps);
  const safeDrain = async (skipAppendToQueue: boolean): Promise<string | undefined> => {
    try {
      await drainQueuedRoutes(skipAppendToQueue);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const fullDeps: AgentApiDeps = {
    callTool: deps.callTool ?? createDirectCallTool(),
    routeCallbacks: deps.routeCallbacks,
    appConfig: deps.appConfig ?? getDirectToolsAppConfig(),
    getInjectedMessages: deps.getInjectedMessages,
    vmEvalStdout: deps.vmEvalStdout,
    vmEvalStderr: deps.vmEvalStderr,
    setupMode: deps.setupMode ?? getDirectToolsSetupMode(),
  };
  const api = createAgentApi(fullDeps);
  const vmList = await listVms();
  const wait = (seconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));

  if (!persistentSandbox || !persistentContext) {
    persistentSandbox = {
      Promise,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      JSON,
      Date,
      Error,
      TypeError,
      RangeError,
      Symbol,
      Map,
      Set,
      RegExp,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      decodeURI,
      decodeURIComponent,
      encodeURI,
      encodeURIComponent,
      ArrayBuffer,
      Int8Array,
      Uint8Array,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array,
      Reflect,
      Proxy,
      WeakMap,
      WeakSet,
      NaN: Number.NaN,
      Infinity: Number.POSITIVE_INFINITY,
      undefined: undefined,
      wait,
      /** Persistent state across ts runs. Use store.x = 1 to persist. Cleared on stop-chat. */
      store: {} as Record<string, unknown>,
    };
    persistentContext = vm.createContext(persistentSandbox, {
      codeGeneration: { strings: true, wasm: false },
    });
  }

  persistentSandbox.console = capturingConsole;
  persistentSandbox.vmEvalStdout = deps.vmEvalStdout ?? "";
  persistentSandbox.vmEvalStderr = deps.vmEvalStderr ?? "";
  persistentSandbox.vmList = vmList;
  const [gmailClient, calendarClient] = await Promise.all([getGmailClient(), getCalendarClient()]);
  persistentSandbox.gmail = gmailClient;
  persistentSandbox.calendar = calendarClient;
  Object.assign(persistentSandbox, api);

  const wrapped = `
    (async () => {
      ${js}
    })()
  `;

  if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Running in vm, timeout:", EVAL_TIMEOUT_MS, "ms");
  try {
    const script = new vm.Script(wrapped, { filename: "agent-code.ts" });
    const resultPromise = script.runInContext(persistentContext!, {
      timeout: EVAL_TIMEOUT_MS,
    });
    const result = await Promise.resolve(resultPromise);
    const drainErr = await safeDrain(false);
    if (drainErr) {
      const injected = fullDeps.getInjectedMessages?.() ?? undefined;
      const askUserReply = getLastAskUserReply();
      return { ok: false, output: getOutput(), error: drainErr, injected, askUserReply };
    }
    const streamOutput = getOutput();
    const returnOutput = result !== undefined ? formatArg(result) : "";
    const output = [streamOutput, returnOutput].filter(Boolean).join(streamOutput && returnOutput ? "\n" : "");
    if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Completed ok, output length:", output.length);
    const injected = fullDeps.getInjectedMessages?.() ?? undefined;
    const askUserReply = getLastAskUserReply();
    return { ok: true, output, injected, askUserReply };
  } catch (err) {
    if (err instanceof VmPowerOnAbortError) {
      const drainErr = await safeDrain(true);
      if (drainErr) {
        const injected = fullDeps.getInjectedMessages?.() ?? undefined;
        const askUserReply = getLastAskUserReply();
        return { ok: false, output: "", error: drainErr, injected, askUserReply };
      }
      const injected = fullDeps.getInjectedMessages?.() ?? undefined;
      const askUserReply = getLastAskUserReply();
      return { ok: true, output: "", injected, askUserReply, vmPowerOnAbort: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const error = stack ? `${msg}\n${stack}` : msg;
    if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Failed:", msg);
    const drainErr = await safeDrain(false);
    const injected = fullDeps.getInjectedMessages?.() ?? undefined;
    const askUserReply = getLastAskUserReply();
    return { ok: false, output: "", error: drainErr ?? error, injected, askUserReply };
  }
}
