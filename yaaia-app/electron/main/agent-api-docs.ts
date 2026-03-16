/**
 * Generate API documentation for the agent.
 * Used in the system prompt so the model knows the TS API surface.
 * Spec is generated from agent-api.ts (code as source of truth).
 * Run: npx tsx scripts/generate-agent-api-spec.ts
 */

import { TOOL_SPECS } from "./agent-api-spec.generated.js";

function formatReturnBlock(schema: string): string {
  if (schema.includes("\n")) {
    return "\n```ts\n" + schema.split("\n").map((l) => "  " + l).join("\n") + "\n```";
  }
  return schema;
}

function docFromSpec(spec: { name: string; description: string; params?: string; returns: string }): string {
  const r = spec.returns;
  let out = `- **${spec.name}**(args): Promise<string> — ${spec.description}`;
  if (spec.params) {
    const paramsFormatted = spec.params.startsWith("  -") ? spec.params : `  - ${spec.params}`;
    out += `\n  Params:\n${paramsFormatted}`;
  }
  out += `\n  Returns: ${formatReturnBlock(r)}`;
  return out;
}

const SECTION_ORDER = ["fs", "top", "mail", "caldav", "vm", "vm_serial"] as const;

function getSection(name: string): (typeof SECTION_ORDER)[number] {
  if (name.startsWith("fs.")) return "fs";
  if (name.startsWith("mail.")) return "mail";
  if (name.startsWith("caldav.")) return "caldav";
  if (name.startsWith("vm.")) return "vm";
  if (name.startsWith("vm_serial.")) return "vm_serial";
  return "top";
}

/** Generate static API docs for the eval runtime. Spec from agent-api.ts. */
export function generateApiDocs(): string {
  const bySection = new Map<(typeof SECTION_ORDER)[number], typeof TOOL_SPECS>();
  for (const s of SECTION_ORDER) bySection.set(s, []);
  for (const spec of TOOL_SPECS) {
    const section = getSection(spec.name);
    bySection.get(section)!.push(spec);
  }

  const sectionLines: string[] = [];
  for (const section of SECTION_ORDER) {
    const specs = bySection.get(section)!;
    if (specs.length === 0) continue;
    const title = section === "top" ? "Top-level" : section;
    sectionLines.push("### " + title, "");
    if (section === "top") {
      sectionLines.push(
        "- **send_message**(content): Promise<string> — Send to bus. Content must use prefix format bus_id:content (bus_id mandatory). Returns: 'Sent to {busId}'. Throws on failure. For multiline or special chars, escape strings per system prompt.",
        "- **ask**(prompt): Promise<string> — Ask user; prompt must use bus_id:prompt or bus_id:wait:prompt (bus_id mandatory). Root or telegram only. Blocks up to 60s. Returns: user reply string.",
        "- **wait**(seconds: number): Promise<void> — Pause for n seconds. Use instead of setTimeout (not available in sandbox).",
        "",
      );
    }
    if (section === "vm") {
      sectionLines.push(
        "Power on or force-kill VMs. For vm_kill: shut down the VM with `shutdown -h now` via vm_serial before killing.",
        "",
      );
    }
    if (section === "vm_serial") {
      sectionLines.push(
        "Connect to a running Linux VM's serial console. VM must be started first. Use for shell commands. Output is ANSI-stripped.",
        "",
        "**Large bash scripts:** Write to fs under shared/ (shared with VM) with template literal, then write_from_file. E.g. `fs.write_file({ path: 'shared/script.sh', content: \`...\` })` then `vm_serial.write_from_file({ vm_id, path: 'script.sh' })`. In template literals escape \`\${VAR}\` as \`\\\${VAR}\` for literal bash vars.",
        "",
        "**Escaping:** Use `chars: string[]` for unambiguous control — each element is one character sent raw. Or use `data` with `raw: true` to skip escaping.",
        "",
      );
    }
    for (const spec of specs) {
      sectionLines.push(docFromSpec(spec), "");
    }
  }

  const lines: string[] = [
    "## Agent TypeScript API",
    "",
    "You write TypeScript code in a single ```ts code block per turn. Always include a plan of execution above the code block (what you will do). Inside the code block, use send_message to explain what is happening — before/after key steps, progress updates. Every message must use prefix format: bus_id:content or bus_id:wait:content. bus_id prefix is mandatory. The code runs in an isolated runtime with access to the following API. All functions are async; use await.",
    "",
    "**Eval output:** Use **console.log**, **console.info**, **console.warn**, **console.error** for all output. That output is captured and fed back to the model as the turn result.",
    "",
    "### Return types and errors",
    "",
    "Every API returns **Promise<string>**. Parse with `JSON.parse(result)` when the tool returns JSON. Types below describe the parsed structure.",
    "",
    "**On failure:** All tools throw `Error` with message starting `Error:`. No try/catch = execution stops.",
    "",
    "### Shared types (for JSON returns)",
    "",
    "```ts",
    "// bus.list",
    "type BusEntry = { bus_id: string; description: string; trust_level?: 'normal'|'root'; is_banned?: boolean; is_connected: boolean };",
    "",
    "// bus.get_history",
    "type HistoryMessage = { role: 'user'|'assistant'; content: string; user_id?: number; user_name?: string; bus_id?: string; timestamp: string; mail_uid?: number; event_uid?: string };",
    "",
    "// passwords.list — only for passwords and TOTPs; usernames, hosts, ports go in KB md files",
    "type PasswordListEntry = { uuid: string; description: string; type: 'string' | 'totp' };",
    "",
    "// passwords.get — returns string. For type=totp: OTP code by default; raw=true returns the seed. When not found: 'Password \"{id}\" not found.'",
    "",
    "// schedule.list",
    "type ScheduleEntry = { id: string; at: string; title: string; instructions: string; created_at: string };",
    "type ListTasksResult = { startup_task?: { title: string; instructions: string }; scheduled: ScheduleEntry[] };",
    "",
    "// mail.fetch_all / mail.fetch_one",
    "type MailEnvelope = {",
    "  date?: Date; subject?: string;",
    "  from?: { address?: string; name?: string }[];",
    "  to?: { address?: string; name?: string }[];",
    "  cc?: { address?: string; name?: string }[];",
    "  bcc?: { address?: string; name?: string }[];",
    "  messageId?: string; inReplyTo?: string;",
    "  replyTo?: { address?: string; name?: string }[];",
    "};",
    "type MailFetchMessage = {",
    "  uid: number; seq: number;",
    "  envelope: MailEnvelope;",
    "  flags: Set<string>|string[];",
    "  internalDate?: Date; size?: number;",
    "  source?: string;  // when query.source=true",
    "  labels?: string[]; threadId?: string;  // Gmail",
    "};",
    "",
    "// caldav.list_calendars",
    "type CaldavCalendar = { url: string; displayName: string };",
    "",
    "// caldav.list_events / caldav.get_event",
    "type CaldavEvent = { url: string; etag?: string; data: string };  // data = iCalendar string",
    "",
    "// telegram_search",
    "type TelegramSearchResult = { bus_id: string; display_name?: string };",
    "",
    "// app_config (read-only, set at startup)",
    "type AppConfig = {",
    "  userName?: string;",
    "  telegramApiId?: number;",
    "  telegramApiHash?: string;",
    "  caldavGoogleClientId?: string;",
    "  caldavGoogleClientSecret?: string;",
    "};",
    "```",
    "",
    "### Read-only globals",
    "",
    "- **app_config**: AppConfig | null — Telegram apiId/apiHash and CalDAV Google OAuth client id/secret. Use for telegram_connect (credentials come from app) or caldav.connect with OAuth.",
    "",
    "### Allowed base directories",
    "",
    "- **fs** (read_file, write_file, append_file, replace_file, update_file, list_files, etc.): Paths relative to ~/yaaia/storage. E.g. `lessons_learned/`, `shared/file.txt`. Use shared/ for VM-visible files.",
    "",
    ...sectionLines,
    "### Workflow",
    "",
    "1. Write plan of execution above the code block",
    "2. task.start({ summary }) at beginning of multi-step task",
    "3. Use send_message inside code to report progress (e.g. before/after key steps)",
    "4. task.finalize({ is_successful, assessment?, clarification? }) before ending — assessment and clarification must start with bus_id:",
    "5. send_message(bus_id:content) for final report — bus_id prefix mandatory",
    "",
    "Multi-step tools (e.g. caldav.oauth_browser) return status; use next code block to continue.",
  ];

  return lines.join("\n");
}
