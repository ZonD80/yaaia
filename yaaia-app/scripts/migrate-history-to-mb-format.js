#!/usr/bin/env node
/**
 * One-time migration: old format -> new format
 * Old: kb/history/YYYY-MM-DD/{bus_id}/{seq}.md, yaaia/mb/{bus_id}.json
 * New: kb/history/{mb_id}/{date}/{seq}.md, kb/history/{mb_id}/properties.md
 *
 * Run: node scripts/migrate-history-to-mb-format.js
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";

const YAAIA = join(homedir(), "yaaia");
const KB_ROOT = join(YAAIA, "kb");
const MB_DIR = join(YAAIA, "mb");
const HISTORY_BASE = join(KB_ROOT, "history");

function busIdToSegment(id) {
  return id.replace(/\//g, "__f__").replace(/\\/g, "__b__");
}

function segmentToBusId(seg) {
  return seg.replace(/__f__/g, "/").replace(/__b__/g, "\\");
}

function main() {
  console.log("[migrate] Starting migration to kb/history/{mb_id}/{date}/{seq}.md");
  if (!existsSync(KB_ROOT)) {
    mkdirSync(KB_ROOT, { recursive: true });
  }
  if (!existsSync(HISTORY_BASE)) {
    mkdirSync(HISTORY_BASE, { recursive: true });
  }

  const busesFromMb = new Set();
  if (existsSync(MB_DIR)) {
    const files = readdirSync(MB_DIR);
    for (const f of files) {
      if (f.endsWith(".json")) {
        const busId = segmentToBusId(f.slice(0, -5).replace(/__f__/g, "/").replace(/__b__/g, "\\"));
        busesFromMb.add(busId);
        const path = join(MB_DIR, f);
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        const props = {
          bus_id: raw.bus_id ?? busId,
          description: String(raw.description ?? ""),
          trust_level: raw.trust_level === "root" ? "root" : "normal",
          is_banned: Boolean(raw.is_banned),
        };
        const mbDir = join(HISTORY_BASE, busIdToSegment(busId));
        mkdirSync(mbDir, { recursive: true });
        const propsPath = join(mbDir, "properties.md");
        const propsContent = [
          "---",
          `bus_id: ${props.bus_id}`,
          `description: ${props.description}`,
          `trust_level: ${props.trust_level}`,
          `is_banned: ${props.is_banned}`,
          "---",
        ].join("\n");
        writeFileSync(propsPath, propsContent, "utf-8");
        console.log("[migrate] Wrote properties for", busId);
      }
    }
  }

  const oldHistoryDir = HISTORY_BASE;
  if (!existsSync(oldHistoryDir)) {
    console.log("[migrate] No old history dir, done.");
    ensureRoot();
    removeMbDir();
    return;
  }

  const topLevel = readdirSync(oldHistoryDir, { withFileTypes: true });
  const dateDirs = topLevel.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name));

  for (const dateEnt of dateDirs) {
    const date = dateEnt.name;
    const datePath = join(oldHistoryDir, date);
    const busDirs = readdirSync(datePath, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const busEnt of busDirs) {
      const busId = segmentToBusId(busEnt.name);
      const busPath = join(datePath, busEnt.name);
      const files = readdirSync(busPath).filter((f) => f.endsWith(".md"));
      const newMbDir = join(HISTORY_BASE, busIdToSegment(busId));
      const newDateDir = join(newMbDir, date);
      if (files.length > 0) {
        mkdirSync(newDateDir, { recursive: true });
        for (const f of files) {
          const src = join(busPath, f);
          const dest = join(newDateDir, f);
          const content = readFileSync(src, "utf-8");
          writeFileSync(dest, content, "utf-8");
        }
        console.log("[migrate] Moved", busId, date, files.length, "files");
      }
      if (!busesFromMb.has(busId)) {
        const propsPath = join(newMbDir, "properties.md");
        if (!existsSync(propsPath)) {
          mkdirSync(newMbDir, { recursive: true });
          const propsContent = [
            "---",
            `bus_id: ${busId}`,
            `description: ""`,
            `trust_level: normal`,
            `is_banned: false`,
            "---",
          ].join("\n");
          writeFileSync(propsPath, propsContent, "utf-8");
          console.log("[migrate] Created properties for", busId, "(from history only)");
        }
      }
    }
  }

  ensureRoot();

  for (const dateEnt of dateDirs) {
    const datePath = join(oldHistoryDir, dateEnt.name);
    rmSync(datePath, { recursive: true });
    console.log("[migrate] Removed old date dir", dateEnt.name);
  }

  removeMbDir();
  console.log("[migrate] Done.");
}

function ensureRoot() {
  const rootDir = join(HISTORY_BASE, "root");
  const propsPath = join(rootDir, "properties.md");
  if (!existsSync(propsPath)) {
    mkdirSync(rootDir, { recursive: true });
    const content = [
      "---",
      "bus_id: root",
      "description: Desktop chat (root)",
      "trust_level: normal",
      "is_banned: false",
      "---",
    ].join("\n");
    writeFileSync(propsPath, content, "utf-8");
    console.log("[migrate] Created root properties");
  }
}

function removeMbDir() {
  if (existsSync(MB_DIR)) {
    rmSync(MB_DIR, { recursive: true });
    console.log("[migrate] Removed yaaia/mb/");
  }
}

main();
