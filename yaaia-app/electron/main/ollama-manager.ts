/**
 * Manages bundled Ollama binary: ensures server is running on port 11434.
 * When Mem0 is enabled, starts Ollama from resources if not already running.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OLLAMA_PORT = 11434;
const OLLAMA_URL = `http://localhost:${OLLAMA_PORT}`;

/** Models used by Mem0. Embedder always needed; LLM only when not using Claude. */
const MEM0_EMBEDDER_MODEL = "nomic-embed-text";
const MEM0_OLLAMA_LLM_MODEL = "llama3.2:3b";
const MEM0_MODELS = [MEM0_EMBEDDER_MODEL, MEM0_OLLAMA_LLM_MODEL];

/** Models to prewarm when using Claude for Mem0 LLM (embedder only). */
export const MEM0_EMBEDDER_ONLY_MODELS = [MEM0_EMBEDDER_MODEL];

let ollamaProcess: ChildProcess | null = null;

function getResourcesDir(): string {
  return app.isPackaged ? join(__dirname, "..", "resources") : join(__dirname, "..", "..", "resources");
}

/** Path to bundled ollama binary (macOS). */
function getBundledOllamaPath(): string | null {
  const resources = getResourcesDir();
  const ollamaDir = join(resources, "ollama");
  const binary = join(ollamaDir, "ollama");
  if (existsSync(binary)) return binary;
  return null;
}

/** Check if Ollama is already running on port 11434. */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start bundled Ollama server. No-op if already running or binary missing. */
export async function ensureOllamaRunning(): Promise<{ ok: boolean; message: string }> {
  if (await isOllamaRunning()) {
    return { ok: true, message: "Ollama already running" };
  }
  const binary = getBundledOllamaPath();
  if (!binary) {
    return { ok: false, message: "Bundled Ollama not found. Run 'npm run build:ollama' and pack again." };
  }
  const cwd = join(binary, "..");
  ollamaProcess = spawn(binary, ["serve"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      OLLAMA_MODELS: join(homedir(), "yaaia", "ollama-models"),
    },
  });
  ollamaProcess.unref();
  ollamaProcess.stdout?.on("data", (chunk) => process.stdout.write(`[Ollama] ${chunk}`));
  ollamaProcess.stderr?.on("data", (chunk) => process.stderr.write(`[Ollama] ${chunk}`));
  ollamaProcess.on("error", (err) => {
    console.warn("[YAAIA] Ollama spawn error:", err);
  });
  // Poll until server responds (up to 15s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isOllamaRunning()) {
      return { ok: true, message: "Ollama started" };
    }
  }
  return { ok: false, message: "Ollama failed to start within 15s" };
}

/** Pre-warm Ollama by pulling Mem0 models. Blocks until all models are ready. */
export async function prewarmOllamaModels(models: string[] = MEM0_MODELS): Promise<void> {
  await Promise.all(
    models.map(async (model) => {
      const res = await fetch(`${OLLAMA_URL}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!res.ok) throw new Error(`${model}: ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let lastStatus = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        for (const line of chunk.split("\n").filter(Boolean)) {
          try {
            const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number };
            if (obj.status && obj.status !== lastStatus) {
              lastStatus = obj.status;
              if (obj.total != null && obj.completed != null) {
                const pct = Math.round((obj.completed / obj.total) * 100);
                console.log(`[Ollama] ${model}: ${obj.status} ${pct}%`);
              } else {
                console.log(`[Ollama] ${model}: ${obj.status}`);
              }
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
      console.log(`[Ollama] ${model}: ready`);
    })
  );
}

/** Stop our spawned Ollama (only if we started it). Does not kill system Ollama. */
export function stopOllama(): void {
  if (ollamaProcess?.pid) {
    try {
      process.kill(ollamaProcess.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    ollamaProcess = null;
  }
}

export { OLLAMA_URL };
