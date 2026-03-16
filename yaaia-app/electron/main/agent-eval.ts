/**
 * Eval runtime for agent-generated TypeScript code.
 * Uses Node vm module for isolation. Transpiles TS to JS via esbuild.
 * Captures stdout (console.log/info/debug), stderr (console.warn/error), and return value.
 */

import vm from "node:vm";
import * as esbuild from "esbuild";
import type { AgentApiDeps } from "./agent-api.js";
import { createAgentApi } from "./agent-api.js";
import { createDirectCallTool, getDirectToolsAppConfig } from "./direct-tools.js";

const EVAL_TIMEOUT_MS = 120_000;

export interface EvalResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Queued messages (Telegram, email, CalDAV, etc.) received during eval. */
  injected?: { formatted: string; raw: string };
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

function createCapturingConsole(onOutputChunk?: (text: string) => void): {
  console: Console;
  getOutput: () => string;
} {
  const chunks: { stream: "stdout" | "stderr"; text: string }[] = [];

  const write = (stream: "stdout" | "stderr", args: unknown[]) => {
    const text = args.map(formatArg).join(" ") + "\n";
    chunks.push({ stream, text });
    const displayText = stream === "stderr" ? text.replace(/^/gm, "stderr: ") : text;
    onOutputChunk?.(displayText);
  };

  const capturingConsole = {
    log: (...args) => write("stdout", args),
    info: (...args) => write("stdout", args),
    debug: (...args) => write("stdout", args),
    warn: (...args) => write("stderr", args),
    error: (...args) => write("stderr", args),
    trace: (...args) => write("stderr", ["Trace:", ...args]),
    dir: (obj) => write("stdout", [formatArg(obj)]),
    dirxml: (...args) => write("stdout", args),
    table: (data) => write("stdout", [typeof data === "object" && data !== null ? JSON.stringify(data, null, 2) : formatArg(data)]),
    count: () => {},
    countReset: () => {},
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    time: () => {},
    timeLog: () => {},
    timeEnd: () => {},
    assert: (value, ...args) => {
      if (!value) write("stderr", ["Assertion failed:", ...args]);
    },
    clear: () => {},
    profile: () => {},
    profileEnd: () => {},
    timeStamp: () => {},
  } as Console;

  const getOutput = (): string => {
    return chunks.map((c) => (c.stream === "stderr" ? c.text.replace(/^/gm, "stderr: ") : c.text)).join("");
  };

  return { console: capturingConsole, getOutput };
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

  const { console: capturingConsole, getOutput } = createCapturingConsole(deps.onOutputChunk);
  const fullDeps: AgentApiDeps = {
    callTool: deps.callTool ?? createDirectCallTool(),
    routeCallbacks: deps.routeCallbacks,
    appConfig: deps.appConfig ?? getDirectToolsAppConfig(),
    getInjectedMessages: deps.getInjectedMessages,
    onOutputChunk: deps.onOutputChunk,
  };
  const api = createAgentApi(fullDeps);
  const wait = (seconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
  const sandbox: Record<string, unknown> = {
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
    console: capturingConsole,
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    undefined: undefined,
    wait,
    ...api,
  };

  const wrapped = `
    (async () => {
      ${js}
    })()
  `;

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: true, wasm: false },
  });

  if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Running in vm, timeout:", EVAL_TIMEOUT_MS, "ms");
  try {
    const script = new vm.Script(wrapped, { filename: "agent-code.ts" });
    const resultPromise = script.runInContext(context, {
      timeout: EVAL_TIMEOUT_MS,
    });
    const result = await Promise.resolve(resultPromise);
    const streamOutput = getOutput();
    const returnOutput = result !== undefined ? formatArg(result) : "";
    const output = [streamOutput, returnOutput].filter(Boolean).join(streamOutput && returnOutput ? "\n" : "");
    if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Completed ok, output length:", output.length);
    const injected = fullDeps.getInjectedMessages?.() ?? undefined;
    return { ok: true, output, injected };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const error = stack ? `${msg}\n${stack}` : msg;
    if (process.env.DEBUG?.includes("yaaia")) console.log("[YAAIA Eval] Failed:", msg);
    const injected = fullDeps.getInjectedMessages?.() ?? undefined;
    return { ok: false, output: "", error, injected };
  }
}
