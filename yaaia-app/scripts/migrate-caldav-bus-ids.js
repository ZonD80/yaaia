#!/usr/bin/env node
/**
 * One-time migration: remove all caldav-* history buses created with wrong bus IDs.
 *
 * Background: bus IDs were previously computed by calling .split("/").pop() on the
 * calendar URL without stripping trailing slashes first. This caused every calendar
 * to get the bus ID "caldav-google-default" regardless of which calendar it was.
 *
 * The fix computes the correct URL-based ID (e.g. "caldav-google-primary").
 * Run this script once to wipe the stale caldav-* history so the corrected IDs
 * get a clean start on the next caldav__connect.
 *
 * Run: node scripts/migrate-caldav-bus-ids.js
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, rmSync, existsSync } from "node:fs";

const HISTORY_BASE = join(homedir(), "yaaia", "kb", "history");

if (!existsSync(HISTORY_BASE)) {
  console.log("No history directory found, nothing to do.");
  process.exit(0);
}

const entries = readdirSync(HISTORY_BASE, { withFileTypes: true });
const caldavBuses = entries.filter((e) => e.isDirectory() && e.name.startsWith("caldav-"));

if (caldavBuses.length === 0) {
  console.log("No caldav-* buses found, nothing to do.");
  process.exit(0);
}

for (const entry of caldavBuses) {
  const dir = join(HISTORY_BASE, entry.name);
  console.log(`Removing ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`Done. Removed ${caldavBuses.length} caldav-* bus(es).`);
