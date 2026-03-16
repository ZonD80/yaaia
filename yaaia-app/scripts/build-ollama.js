#!/usr/bin/env node
/**
 * Downloads Ollama darwin binary and extracts to resources/ollama.
 * Run before pack when Mem0 + bundled Ollama is needed.
 */
import { mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_VERSION = "v0.18.0";
const URL = `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-darwin.tgz`;
const RESOURCES = join(__dirname, "..", "resources");
const OLLAMA_DIR = join(RESOURCES, "ollama");

function main() {
  mkdirSync(OLLAMA_DIR, { recursive: true });
  const binary = join(OLLAMA_DIR, "ollama");
  if (existsSync(binary)) {
    console.log("[build:ollama] Already present at", OLLAMA_DIR);
    return;
  }
  console.log("[build:ollama] Downloading", URL);
  execSync(`curl -sL "${URL}" | tar -xzf - -C "${OLLAMA_DIR}"`, {
    stdio: "inherit",
  });
  console.log("[build:ollama] Extracted to", OLLAMA_DIR);
}

main();
