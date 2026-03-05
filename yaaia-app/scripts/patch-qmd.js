#!/usr/bin/env node
/**
 * Patch @tobilu/qmd to use XDG_CACHE_HOME for model cache dir.
 * Models will go to $XDG_CACHE_HOME/qmd/models (e.g. ~/yaaia/qmd/qmd/models when XDG_CACHE_HOME=~/yaaia/qmd)
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const llmPath = join(__dirname, "../node_modules/@tobilu/qmd/dist/llm.js");

try {
  let content = readFileSync(llmPath, "utf8");
  const original = 'const MODEL_CACHE_DIR = join(homedir(), ".cache", "qmd", "models");';
  const patched =
    'const MODEL_CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "qmd", "models");';

  if (content.includes(original)) {
    content = content.replace(original, patched);
    writeFileSync(llmPath, content);
    console.log("[YAAIA] Patched @tobilu/qmd: model cache respects XDG_CACHE_HOME");
  } else if (content.includes(patched)) {
    console.log("[YAAIA] @tobilu/qmd already patched");
  } else {
    console.warn("[YAAIA] @tobilu/qmd patch skipped: llm.js format changed");
  }
} catch (e) {
  console.warn("[YAAIA] Could not patch @tobilu/qmd:", e.message);
}
