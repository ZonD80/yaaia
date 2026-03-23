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

const SECTION_ORDER = ["top", "mail", "vm", "vm_serial"] as const;

function getSection(name: string): (typeof SECTION_ORDER)[number] {
  if (name.startsWith("mail.")) return "mail";
  if (name.startsWith("vm.")) return "vm";
  if (name.startsWith("vm_serial.")) return "vm_serial";
  return "top";
}

/** Generate static API docs for the eval runtime. Spec from agent-api.ts. setupMode: include vm_serial section. codeBoundary: runtime boundary for bbtag. */
export function generateApiDocs(options?: { setupMode?: boolean; codeBoundary?: string | null }): string {
  const setupMode = options?.setupMode ?? false;
  const boundary = options?.codeBoundary ?? null;
  const bySection = new Map<(typeof SECTION_ORDER)[number], typeof TOOL_SPECS>();
  for (const s of SECTION_ORDER) bySection.set(s, []);
  for (const spec of TOOL_SPECS) {
    const section = getSection(spec.name);
    if (section === "vm_serial" && !setupMode) continue;
    bySection.get(section)!.push(spec);
  }

  const sectionLines: string[] = [];
  for (const section of SECTION_ORDER) {
    if (section === "vm_serial" && !setupMode) continue;
    const specs = bySection.get(section)!;
    if (specs.length === 0) continue;
    const title = section === "top" ? "Top-level" : section;
    sectionLines.push("### " + title, "");
    if (section === "top") {
      sectionLines.push(
        "- **store** — Persistent object across ts runs. Use `store.x = 1` to persist. Cleared on stop-chat.",
        "- **console.log('bus_id:content')** — Send to bus. Content must use prefix format bus_id:content (bus_id mandatory). Parsed and routed during execution. Streams to chat. Example: `console.log('root:Connecting...');`",
        "- **console.log('bus_id:wait:content')** — Ask user; blocks up to 60s. Root or telegram only.",
        "- **wait**(seconds: number): Promise<void> — Pause for n seconds. Use instead of setTimeout (not available in sandbox).",
        "",
      );
    }
    if (section === "vm") {
      if (setupMode) {
        sectionLines.push(
          "Power on or force-kill VMs. Use vmList for VM ids. vmControl.power_on returns setup checklist (see VM_SETUP.md). vm_serial available for setup.",
          "",
        );
      } else {
        sectionLines.push(
          "Power on or force-kill VMs. Use vmList for VM ids. vmControl.power_on powers VM on. vm_serial not available (use setup mode for VM setup).",
          "",
        );
      }
    }
    if (section === "vm_serial") {
      sectionLines.push(
        "Connect to a running Linux VM's serial console. VM must be started first. Use for shell commands. Output is ANSI-stripped.",
        "",
        "**Large bash scripts:** Use vm-bash blocks with heredoc: `cat > /mnt/shared/script.sh << 'EOF'` ... `EOF`. write_from_file reads from shared (path relative to shared root).",
        "",
        "**Escaping:** Use `chars: string[]` for unambiguous control — each element is one character sent raw. Or use `data` with `raw: true` to skip escaping.",
        "",
      );
    }
    for (const spec of specs) {
      const displaySpec =
        section === "vm" && spec.name.startsWith("vm.")
          ? { ...spec, name: spec.name.replace("vm.", "vmControl.") }
          : spec;
      sectionLines.push(docFromSpec(displaySpec), "");
    }
  }

  const blockFormat = boundary
    ? `Use [${boundary}=ts]...[/${boundary}] for TypeScript and [${boundary}=vm-bash:N:user]...[/${boundary}] for vm-bash (N=timeout sec, user=run as). Content can include any characters.`
    : "Use [{key}=ts]...[/{key}] and [{key}=vm-bash:N:user]...[/{key}] (key from system prompt).";
  const lines: string[] = [
    "## Agent TypeScript API",
    "",
    `You write TypeScript code in code blocks per turn. You may add vm-bash blocks; they run sequentially with ts blocks in document order (bash1 → ts1 → bash2 → ts2). ${blockFormat} Each ts block receives vmEvalStdout and vmEvalStderr: per-user buffers (append-only, cleared on stop-chat). Use vmEvalStdout.root, vmEvalStdout[user_id] for stdout; vmEvalStderr.root, vmEvalStderr[user_id] for stderr. Use .slice(-n) for last n chars. Always include a plan of execution above the code block (what you will do). Inside the code block, use console.log('bus_id:content') to send messages — parsed and routed to buses, streams during execution. Every message must use prefix format: bus_id:content or bus_id:wait:content. bus_id prefix is mandatory. The code runs in an isolated runtime with access to the following API. All functions are async; use await.`,
    "",
    "**Eval output:** Use **console.log**, **console.info**, **console.warn**, **console.error** for output.",
    "",
    "### Return types and errors",
    "",
    "Every API returns **Promise<string>**. Parse with `JSON.parse(result)` when the tool returns JSON. Types below describe the parsed structure.",
    "",
    "**On failure:** All tools throw `Error` with message starting `Error:`. No try/catch = execution stops.",
    "",
    "### vmEvalStdout / vmEvalStderr (from vm-bash)",
    "",
    "Blocks run sequentially (bash1 → ts1 → bash2 → ts2); output appends to per-user buffers. Cleared on stop-chat.",
    "```ts",
    "vmEvalStdout: Record<string, string>;  // vmEvalStdout.root, vmEvalStdout[user_id]; use .slice(-n) for last n chars",
    "vmEvalStderr: Record<string, string>;  // vmEvalStderr.root, vmEvalStderr[user_id]",
    "```",
    "",
    "### Shared types (for JSON returns)",
    "",
    "```ts",
    "// bus.list",
    "type BusEntry = { bus_id: string; description: string; trust_level?: 'normal'|'root'; is_banned?: boolean; is_connected: boolean };",
    "",
    "// contacts.list / contacts.search / contacts.get",
    "type Contact = { id: string; name: string; identifier: string; trust_level: 'normal'|'root'; bus_ids: string[]; notes: string };",
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
    "// telegram_search",
    "type TelegramSearchResult = { bus_id: string; display_name?: string };",
    "",
    "// vmList (read-only, available in eval)",
    "type VmInfo = { id: string; name: string; path: string; status: 'running'|'stopped'; ramMb: number; diskGb: number };",
    "",
    "// app_config (read-only, set at startup)",
    "type AppConfig = {",
    "  telegramApiId?: number;",
    "  telegramApiHash?: string;",
    "};",
    "```",
    "",
    "### Read-only globals",
    "",
    "- **vmList**: VmInfo[] — VMs known to YaaiaVM. Use v.id for vmControl.power_on, vmControl.kill, vm_serial.connect.",
    "- **app_config**: AppConfig | null — Telegram apiId/apiHash. Telegram connects via sidebar or auto-connects on chat start.",
    "",
    "### Google API (Gmail, Calendar)",
    "",
    "When authorized via \"Authorize Google API for agent\":",
    "",
    "- **gmail**: Gmail API v1 client | null — Use `gmail.users.messages.list({ userId: 'me' })`, `gmail.users.messages.get()`, `gmail.users.messages.send()`, etc. See googleapis.dev/nodejs/googleapis/latest/gmail.",
    "- **calendar**: Google Calendar API v3 client | null — Use `calendar.events.list({ calendarId: 'primary' })`, `calendar.events.insert()`, etc. See googleapis.dev/nodejs/googleapis/latest/calendar.",
    "",
    "Check `if (gmail)` / `if (calendar)` before use. When not authorized, they are null.",
    "",
    "### File operations",
    "",
    "No host fs API. Shared folder at **/mnt/shared** in VM — empty by default. Build your hierarchy with vm-bash: `cat`, `echo`, `mkdir`, `cp`, `mv`, `rm`, heredocs.",
    "",
    ...sectionLines,
    "### Workflow",
    "",
    "1. Write plan of execution above the code block",
    "2. task.start({ summary }) at beginning of multi-step task",
    "3. Use console.log('bus_id:content') inside code to report progress (e.g. before/after key steps)",
    "4. task.finalize({ is_successful }) before ending",
    "",
    "Multi-step tools (e.g. mail.connect) return status; use next code block to continue.",
  ];

  return lines.join("\n");
}
