/**
 * macOS: optional `native/yaaia-voip-helper` (Swift) for Apple STT/TTS.
 * Build: `npm run build:voip-helper`
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

function repoRootFromMain(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../..");
}

/** Resolve path to Swift helper binary (dev: .build, packaged: resources). */
export function resolveVoipHelperPath(): string | null {
  if (app.isPackaged) {
    const p = join(process.resourcesPath, "yaaia-voip-helper");
    return existsSync(p) ? p : null;
  }
  const root = repoRootFromMain();
  const patterns = [
    join(root, "native/yaaia-voip-helper/.build/arm64-apple-macosx/release/yaaia-voip-helper"),
    join(root, "native/yaaia-voip-helper/.build/x86_64-apple-macosx/release/yaaia-voip-helper"),
    join(root, "resources/yaaia-voip-helper"),
  ];
  for (const p of patterns) {
    if (existsSync(p)) return p;
  }
  return null;
}

export type AppleSpeechOk = { ok: true; text?: string; outPath?: string };
export type AppleSpeechErr = { ok: false; error: string };
export type AppleSpeechResult = AppleSpeechOk | AppleSpeechErr;

/**
 * Remove routing/metadata so TTS does not read it aloud: `bus_id:` labels,
 * optional `telegram-<id>:` line prefixes (same format as bus history), and BBCode tags.
 */
export function sanitizeTextForAppleTts(text: string): string {
  let s = text;
  s = s.replace(/\bbus_id\s*:\s*/gi, "");
  s = s.replace(/(?:^|\n)\s*telegram-\d+\s*:\s*/g, "\n");
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(
      /\[\/?(?:b|i|u|s|url|quote|code|img|list|color|size|font|center|left|right|spoiler|youtube|\*)(?:=[^\]]*)?\]/gi,
      "",
    );
  }
  return s
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/^\s+|\s+$/gm, "")
    .trim();
}

function runHelperJsonLine(payload: Record<string, unknown>): Promise<AppleSpeechResult> {
  return new Promise((resolve) => {
    const bin = resolveVoipHelperPath();
    if (!bin) {
      resolve({ ok: false, error: "yaaia-voip-helper not built (run npm run build:voip-helper)" });
      return;
    }
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const line = JSON.stringify(payload) + "\n";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("close", (code) => {
      const first = out.trim().split("\n")[0];
      if (code !== 0) {
        resolve({ ok: false, error: err || `exit ${code}` });
        return;
      }
      try {
        const j = JSON.parse(first ?? "{}") as AppleSpeechResult;
        resolve(j);
      } catch {
        resolve({ ok: false, error: out || err || "invalid helper output" });
      }
    });
    child.stdin?.write(line);
    child.stdin?.end();
  });
}

/** Transcribe audio file (caf/aiff/wav). Requires Speech Recognition permission on macOS. */
export function appleSttFromFile(audioPath: string): Promise<AppleSpeechResult> {
  return runHelperJsonLine({ cmd: "stt", audioPath });
}

/** Synthesize text to AIFF via system `say` (Apple voices). */
export function appleTtsToFile(text: string, outPath: string): Promise<AppleSpeechResult> {
  const cleaned = sanitizeTextForAppleTts(text);
  if (!cleaned) {
    return Promise.resolve({ ok: false, error: "nothing to speak after stripping bus_id / BBCode" });
  }
  return runHelperJsonLine({ cmd: "tts", text: cleaned, outPath });
}
