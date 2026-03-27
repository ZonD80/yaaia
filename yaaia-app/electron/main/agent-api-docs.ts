/**
 * Per-module API documentation for the agent eval runtime.
 * Call `{module}.help()` in ts blocks to load docs on demand (not in system prompt).
 * Spec source: agent-api.ts → TOOL_SPECS. Run: npx tsx scripts/generate-agent-api-spec.ts
 */

import { TOOL_SPECS } from "./agent-api-spec.generated.js";
import { getMemoryHelpText } from "./memory-store.js";
import { getHistoryDb } from "./message-db.js";

export type AgentHelpModule =
  | "runtime"
  | "store"
  | "bus"
  | "contacts"
  | "mail"
  | "passwords"
  | "schedule"
  | "soul"
  | "task"
  | "telegram_search"
  | "vmControl"
  | "vm_serial"
  | "memory";

export interface AgentHelpOptions {
  setupMode?: boolean;
  codeBoundary?: string | null;
}

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

function blockFormatLine(boundary: string | null | undefined): string {
  return boundary
    ? `Use [${boundary}=ts]...[/${boundary}] for TypeScript and [${boundary}=vm-bash:N:user]...[/${boundary}] for vm-bash (N=timeout sec, user=run as). Between tags write raw code only — do not wrap with markdown code fences (\`\`\` / \`\`\`typescript).`
    : "Use [{key}=ts]...[/{key}] and [{key}=vm-bash:N:user]...[/{key}] (key from system prompt). Raw code between tags; no markdown fences inside bbtags.";
}

function filterSpecsByPrefix(prefix: string): typeof TOOL_SPECS {
  return TOOL_SPECS.filter((s) => s.name === prefix || s.name.startsWith(prefix + "."));
}

function vmDisplaySpec(spec: (typeof TOOL_SPECS)[number]): (typeof TOOL_SPECS)[number] {
  if (spec.name.startsWith("vm.")) {
    return { ...spec, name: spec.name.replace("vm.", "vmControl.") };
  }
  return spec;
}

/** Short pointer for system prompt — full docs via `runtime.help()` and per-module `.help()` in eval. */
export function generateApiHelpIndex(options?: AgentHelpOptions): string {
  const setupMode = options?.setupMode ?? false;
  const boundary = options?.codeBoundary ?? null;
  const vmSerialLine = setupMode
    ? "- **vm_serial.help()** — Linux VM serial console (setup mode only)."
    : "- **vm_serial** — not available; use setup mode for `vm_serial.help()`.";
  const lines = [
    "## TypeScript API reference (on demand)",
    "",
    "Full API documentation is **not** inlined here. Inside a ts bbtag, call:",
    "",
    "- **runtime.help()** — Eval overview: code blocks, `vmEvalStdout` / `vmEvalStderr`, shared JSON types, read-only globals (`vmList`, `app_config`), Google clients, file ops, workflow.",
    "- **store.help()** — Persistent `store`, `console.log` routing, `wait`, `get_datetime`.",
    "- **bus.help()**, **contacts.help()**, **mail.help()**, **passwords.help()**, **schedule.help()**, **soul.help()**, **task.help()**, **memory.help()**, **vmControl.help()** — per-namespace tools.",
    "- **telegram_search.help()** — resolve Telegram username to bus_id (function has a `.help` property).",
    vmSerialLine,
    "",
    `Code block tags: ${blockFormatLine(boundary)}`,
  ];
  return lines.join("\n");
}

/** Markdown documentation for one eval module (return as string; use `console.log` to surface). */
export function generateModuleHelp(module: AgentHelpModule, options?: AgentHelpOptions): string {
  const setupMode = options?.setupMode ?? false;
  const boundary = options?.codeBoundary ?? null;
  const bf = blockFormatLine(boundary);

  switch (module) {
    case "runtime": {
      const lines: string[] = [
        "# runtime — eval environment",
        "",
        `You write TypeScript in bbtags (not markdown fenced code). vm-bash bbtags run sequentially with ts bbtags (bash1 → ts1 → bash2 → ts2). ${bf} Each ts segment receives **vmEvalStdout** and **vmEvalStderr**: per-user buffers (append-only, cleared on stop-chat). Use vmEvalStdout.root, vmEvalStdout[user_id]; same for stderr. Use .slice(-n) for last n chars. Include a plan of execution above the ts bbtag. Inside the tag pair, use **console.log('bus_id:content')** to send messages — parsed and routed to buses. Every message: **bus_id:content** or **bus_id:wait:content**. bus_id prefix is mandatory. All API methods are async; use await.`,
        "",
        "**Eval output:** **console.log**, **console.info**, **console.warn**, **console.error**.",
        "",
        "## Return types and errors",
        "",
        "Every tool returns **Promise<string>**. Parse with `JSON.parse(result)` when the tool returns JSON.",
        "",
        "**On failure:** tools throw `Error` with message starting `Error:`. No try/catch = execution stops.",
        "",
        "## vmEvalStdout / vmEvalStderr (from vm-bash)",
        "",
        "Blocks run sequentially; output appends to per-user buffers. Cleared on stop-chat.",
        "```ts",
        "vmEvalStdout: Record<string, string>;",
        "vmEvalStderr: Record<string, string>;",
        "```",
        "",
        "## Shared types (JSON returns)",
        "",
        "```ts",
        "// bus.list",
        "type BusEntry = { bus_id: string; description: string; trust_level?: 'normal'|'root'; is_banned?: boolean; is_connected: boolean };",
        "",
        "// contacts.list / contacts.search / contacts.get",
        "type Contact = { id: string; name: string; identifier: string; trust_level: 'normal'|'root'; bus_ids: string[]; notes: string };",
        "",
        "// bus.get_history",
        "type HistoryMessage = { role: 'user'|'assistant'; content: string; db_id?: number; external_message_id?: string; user_id?: number; user_name?: string; bus_id?: string; timestamp: string; mail_uid?: number; event_uid?: string };",
        "",
        "// passwords.list",
        "type PasswordListEntry = { uuid: string; description: string; type: 'string' | 'totp' };",
        "",
        "// passwords.get — string; totp: OTP by default; raw=true returns seed",
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
        "type MailFetchMessage = { uid: number; seq: number; envelope: MailEnvelope; flags: Set<string>|string[]; internalDate?: Date; size?: number; source?: string; labels?: string[]; threadId?: string };",
        "",
        "// telegram_search",
        "type TelegramSearchResult = { bus_id: string; display_name?: string };",
        "",
        "// vmList",
        "type VmInfo = { id: string; name: string; path: string; status: 'running'|'stopped'; ramMb: number; diskGb: number };",
        "",
        "// app_config",
        "type AppConfig = { telegramApiId?: number; telegramApiHash?: string };",
        "```",
        "",
        "## Read-only globals",
        "",
        "- **vmList**: VmInfo[] — use v.id for vmControl.power_on, vmControl.kill, vm_serial.connect.",
        "- **app_config**: AppConfig | null — Telegram apiId/apiHash.",
        "",
        "## Google API (Gmail, Calendar)",
        "",
        "When authorized: **gmail** and **calendar** are googleapis clients or null. Check `if (gmail)` / `if (calendar)`. See googleapis.dev for Gmail/Calendar.",
        "",
        "## File operations",
        "",
        "No host fs API. Shared folder at **/mnt/shared** in VM — use vm-bash to create files.",
        "",
        "## Workflow",
        "",
        "1. Plan above the code block",
        "2. task.start({ summary }) at start of multi-step work",
        "3. console.log('bus_id:content') for progress",
        "4. task.finalize({ is_successful }) before ending",
      ];
      return lines.join("\n");
    }

    case "store": {
      const specs = filterSpecsByPrefix("get_datetime");
      const toolLines = specs.map((s) => docFromSpec(s));
      const lines: string[] = [
        "# store — persistence and I/O helpers",
        "",
        "- **store** — Persistent object across ts runs (`store.x = 1`). Cleared on stop-chat. Use **memory** (see `memory.help()`) for durable cross-conversation knowledge with provenance.",
        "- **console.log('bus_id:content')** — Send to bus; prefix mandatory. **console.log('bus_id:wait:content')** — ask user (blocks up to 60s; root or telegram).",
        "- **wait**(seconds): Promise<void> — pause; setTimeout is not available.",
        "",
        "## Tool",
        "",
        ...toolLines,
        "",
      ];
      return lines.join("\n");
    }

    case "bus": {
      const specs = filterSpecsByPrefix("bus").map((s) => docFromSpec(s));
      return ["# bus", "", ...specs, ""].join("\n");
    }

    case "contacts": {
      const specs = filterSpecsByPrefix("contacts").map((s) => docFromSpec(s));
      return ["# contacts", "", ...specs, ""].join("\n");
    }

    case "mail": {
      const specs = filterSpecsByPrefix("mail").map((s) => docFromSpec(s));
      return ["# mail", "", ...specs, ""].join("\n");
    }

    case "passwords": {
      const specs = filterSpecsByPrefix("passwords").map((s) => docFromSpec(s));
      return ["# passwords", "", ...specs, ""].join("\n");
    }

    case "schedule": {
      const specs = filterSpecsByPrefix("schedule").map((s) => docFromSpec(s));
      return ["# schedule", "", ...specs, ""].join("\n");
    }

    case "soul": {
      const specs = filterSpecsByPrefix("soul").map((s) => docFromSpec(s));
      return ["# soul", "", ...specs, ""].join("\n");
    }

    case "task": {
      const specs = filterSpecsByPrefix("task").map((s) => docFromSpec(s));
      return ["# task", "", ...specs, ""].join("\n");
    }

    case "telegram_search": {
      const spec = TOOL_SPECS.find((s) => s.name === "telegram_search");
      const lines = spec ? [docFromSpec(spec)] : [];
      return ["# telegram_search", "", ...lines, ""].join("\n");
    }

    case "vmControl": {
      const intro = setupMode
        ? "Power on or force-kill VMs. Use vmList for ids. vmControl.power_on returns setup checklist in setup mode."
        : "Power on or force-kill VMs. vm_serial is not available outside setup mode.";
      const specs = filterSpecsByPrefix("vm").map((s) => docFromSpec(vmDisplaySpec(s)));
      return ["# vmControl", "", intro, "", ...specs, ""].join("\n");
    }

    case "memory": {
      const persisted = getMemoryHelpText(getHistoryDb()).trim();
      const specs = filterSpecsByPrefix("memory").map((s) => docFromSpec(s));
      const lines: string[] = ["# memory — global durable knowledge", ""];
      if (persisted) {
        lines.push("## Agent-authored notes", "", persisted, "", "---", "");
      }
      lines.push(
        "Cross-conversation recall with provenance. v1 search uses FTS5/LIKE only (semantic search is phase 2).",
        "",
        ...specs,
        ""
      );
      return lines.join("\n");
    }

    case "vm_serial": {
      if (!setupMode) {
        return "# vm_serial\n\nNot available — enable setup mode for vm_serial tools.\n";
      }
      const lines: string[] = [
        "# vm_serial — Linux VM serial console",
        "",
        "Connect to a running VM. Output is ANSI-stripped.",
        "",
        "**Large bash scripts:** vm-bash blocks with heredoc to /mnt/shared; **write_from_file** reads from shared.",
        "",
        "**Escaping:** use `chars: string[]` for raw characters, or `data` with `raw: true`.",
        "",
        "Methods map to vm_serial.* (connect, read, write, write_from_file, disconnect).",
        "",
      ];
      return lines.join("\n");
    }

  }
}
