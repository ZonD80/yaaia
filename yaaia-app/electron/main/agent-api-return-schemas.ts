/**
 * Declarative return schemas for all tools.
 * Extracted from source: message-bus-store, history-store, passwords-store,
 * schedule-store, mail-client, caldav-client, telegram-client.
 * All tools return Promise<string>; these types describe JSON.parse(result).
 */

export const RETURN_SCHEMAS: Record<string, string> = {
  "bus.list": `BusEntry[] — see Shared types`,
  "bus.get_history": `HistoryMessage[] — see Shared types`,
  "bus.set_properties": `"Properties set for {mb_id}."`,
  "bus.delete": `"Bus {mb_id} deleted."`,

  "identity.list": `Identity[] — see Shared types`,
  "identity.get": `IdentityWithNote | null — identity + note`,
  "identity.create": `string — created id`,
  "identity.update": `void`,
  "identity.delete": `void`,
  "identity.set_note": `void`,
  "identity.is_trusted": `boolean`,

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

  "caldav.oauth_browser": `string — OAuth URL to open in browser`,

  "caldav.list_calendars": `{ url: string; displayName: string }[]`,

  "caldav.list_events": `{ url: string; etag?: string; data: string }[] — data = iCalendar string`,

  "caldav.get_event": `{ url: string; etag?: string; data: string } — data = full iCalendar string`,

  "caldav.status": `{ connected: boolean }`,

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
  identity_list: `Identity[]`,
  identity_get: `IdentityWithNote | null`,
  identity_create: `string`,
  identity_update: `void`,
  identity_delete: `void`,
  identity_set_note: `void`,
  is_trusted: `boolean`,
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
  "caldav.connect": `"Connected. Bus(es): {comma-separated busIds}."`,
  "caldav.disconnect": `"Disconnected."`,
  "caldav.create_event": `"Event created."`,
  "caldav.update_event": `"Event updated."`,
  "caldav.delete_event": `"Event deleted."`,

  // FS (delegated)
  "fs.read_file": `string — file content`,
  "fs.write_file": `string`,
  "fs.update_file": `string`,
  "fs.list_files": `string`,
  "fs.delete_file": `string`,
  "fs.delete_directory": `string`,
  "fs.create_directory": `string`,
  "fs.move_path": `string`,
  "fs.copy_path": `string`,

  // VM power control
  "vm.power_on": `"VM started." | "Error: ..."`,
  "vm.kill": `"VM killed." | "Error: ..."`,

  // vm_serial (Linux VM console)
  "vm_serial.connect": `"Connected to VM serial console." | "Error: ..."`,
  "vm_serial.write_from_file": `"Sent." | "Error: ..."`,
  "vm_serial.read": `string — buffered output (ANSI stripped) or "(no output yet)"`,
  "vm_serial.write": `"Sent." | "Error: ..."`,
  "vm_serial.disconnect": `"Disconnected."`,

  // Special
  telegram_connect: `"Connected. Buses: " + JSON.stringify(BusEntry[]) + ". Missed messages (appended):\\n..." or "Connected. Buses: " + JSON.stringify(BusEntry[]) + ". {instruction}"`,
  "mail.mailbox_create": `object — imapflow result`,
  "mail.message_copy": `object — imapflow result`,
  "mail.append": `object — imapflow result`,
};
