/**
 * Declarative return schemas for all tools.
 * Extracted from source: message-db, passwords-store,
 * schedule-store, mail-client, telegram-client.
 * All tools return Promise<string>; these types describe JSON.parse(result).
 */

export const RETURN_SCHEMAS: Record<string, string> = {
  "bus.list": `BusEntry[] — see Shared types`,
  "bus.get_history": `HistoryMessage[] — see Shared types`,
  "bus.set_properties": `"Properties set for {mb_id}."`,
  "bus.delete": `"Bus {mb_id} deleted."`,
  "bus.call": `{ ok: true; bus_id: string; call_id: string; key_fingerprint: string; encryption_key_b64: string }`,
  "bus.pickup": `{ ok: true; bus_id: string; call_id: string; key_fingerprint: string; encryption_key_b64: string }`,
  "bus.hangup": `{ ok: true; hung_up: true; bus_id: string }`,
  "bus.reject": `{ ok: true; rejected?: true; ended?: string }`,

  "contacts.list": `Contact[] — see Shared types`,
  "contacts.search": `Contact[] — filtered by name/notes`,
  "contacts.get": `Contact | null — contact with notes`,
  "contacts.create": `string — created id`,
  "contacts.update": `void`,
  "contacts.delete": `void`,
  "contacts.is_trusted": `boolean`,
  "soul.get": `string — SOUL.md content`,
  "soul.set": `void`,

  "schedule.add": `"Scheduled task \\"{title}\\" for {at} (id: {id})."`,
  "schedule.list": `ListTasksResult — see Shared types`,
  "schedule.delete": `"Deleted scheduled task {task_id}."`,

  "task.start": `"Task started."`,
  "task.finalize": `"Task finalized."`,

  "passwords.list": `PasswordListEntry[] — see Shared types`,

  "passwords.get": `string — For type=string: the value. For type=totp: OTP code (6 digits) by default; raw=true returns the seed. When not found: "Password \\"{id}\\" not found." (id = uuid or description)`,

  list_buses: `BusEntry[] — see Shared types`,
  get_bus_history: `HistoryMessage[] — see Shared types`,
  list_tasks: `ListTasksResult — see Shared types`,

  telegram_search: `TelegramSearchResult — see Shared types`,

  "mail.list": `{ path: string; name: string; specialUse?: string[]; status?: { messages?: number; unseen?: number; uidNext?: number; uidValidity?: string; recent?: number; highestModseq?: string } }[]`,

  "mail.list_tree": `Nested tree from imapflow listTree()`,

  "mail.status": `{ path: string; ... } — status fields from query`,

  "mail.get_quota": `IMAP GETQUOTA result`,

  "mail.fetch_all": `MailFetchMessage[] — see Shared types (envelope: date, subject, from, to, cc, bcc, messageId; flags; internalDate; size; source?; labels?; threadId?)`,

  "mail.fetch_one": `MailFetchMessage | null — see Shared types`,

  "mail.search": `number[] — UIDs`,

  get_datetime: `string — ISO 8601 (e.g. "2025-03-15T12:00:00.000Z")`,

  // Status-only returns (no JSON)
  set_mb_properties: `"Properties set for {mb_id}."`,
  delete_bus: `"Bus {mb_id} deleted."`,
  "passwords.set": `"Password set. uuid=\\"{uuid}\\""`,
  "passwords.delete": `"Password \\"{id}\\" deleted." (id = uuid or description)`,
  schedule_task: `"Scheduled task \\"{title}\\" for {at} (id: {id})."`,
  delete_scheduled_task: `"Deleted scheduled task {task_id}."`,
  start_task: `"Task started."`,
  finalize_task: `"Task finalized."`,
  contacts_list: `Contact[]`,
  contacts_search: `Contact[]`,
  contacts_get: `Contact | null`,
  contacts_create: `string`,
  contacts_update: `void`,
  contacts_delete: `void`,
  contacts_is_trusted: `boolean`,
  soul_get: `string`,
  soul_set: `void`,
  "mail.connect": `"Connected. Bus {busId} created. {n} message(s) loaded."`,
  "mail.disconnect": `"Disconnected."`,
  "mail.mailbox_open": `"Opened {path}"`,
  "mail.mailbox_close": `"Closed."`,
  "mail.mailbox_rename": `"Renamed."`,
  "mail.mailbox_delete": `"Deleted."`,
  "mail.mailbox_subscribe": `"Subscribed."`,
  "mail.mailbox_unsubscribe": `"Unsubscribed."`,
  "mail.download": `"Saved to {absolute_path}"`,
  "mail.message_delete": `"Deleted."`,
  "mail.message_move": `"Moved."`,
  "mail.message_flags_add": `"Done."`,
  "mail.message_flags_remove": `"Done."`,
  "mail.message_flags_set": `"Done."`,
  "mail.set_flag_color": `"Done."`,
  "mail.message_labels_add": `"Done."`,
  "mail.message_labels_remove": `"Done."`,
  "mail.message_labels_set": `"Done."`,
  // VM power control
  "vm.power_on": `(non-setup: aborts eval, shows notice) | "Error: ..."`,
  "vm.kill": `"VM killed." | "Error: ..."`,

  // vm_serial (Linux VM console)
  "vm_serial.connect": `"Connected to VM serial console." | "Error: ..."`,
  "vm_serial.write_from_file": `"Sent." | "Error: ..."`,
  "vm_serial.read": `string — buffered output (ANSI stripped) or "(no output yet)"`,
  "vm_serial.write": `"Sent." | "Error: ..."`,
  "vm_serial.disconnect": `"Disconnected."`,

  "memory.put": `{ id: number }`,
  "memory.get": `MemoryEntry | null — see memory.help()`,
  "memory.list": `MemoryEntry[]`,
  "memory.delete": `string — confirmation`,
  "memory.find": `MemoryEntry[] — v1 FTS5/LIKE only; phase 2 may add vectors`,
  "memory.set_help": `"Memory help text updated."`,

  // Special
  "mail.mailbox_create": `object — imapflow result`,
  "mail.message_copy": `object — imapflow result`,
  "mail.append": `object — imapflow result`,
};
