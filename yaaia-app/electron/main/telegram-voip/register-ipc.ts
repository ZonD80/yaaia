import { ipcMain } from "electron";
import { appleSttFromFile, appleTtsToFile } from "./apple-speech-bridge.js";

/** Local Apple STT/TTS only — Telegram MTProto + VoIP run in yaaia-tg-gateway (Go). */
export function registerTelegramVoipIpc(): void {
  ipcMain.handle("voip-apple-stt-file", async (_e, audioPath: string, busId?: string) => {
    if (typeof audioPath !== "string" || !audioPath.trim()) {
      return { ok: false as const, error: "audioPath required" };
    }
    const result = await appleSttFromFile(audioPath.trim());
    if (!result.ok) {
      return result;
    }
    const raw = result.text ?? "";
    const id = typeof busId === "string" && busId.trim() !== "" ? busId.trim() : "";
    const text = id !== "" ? `${id}:${raw}` : raw;
    return { ok: true as const, text };
  });

  ipcMain.handle("voip-apple-tts-file", async (_e, text: string, outPath: string) => {
    if (typeof text !== "string" || typeof outPath !== "string") {
      return { ok: false as const, error: "text and outPath required" };
    }
    return appleTtsToFile(text, outPath.trim());
  });
}
