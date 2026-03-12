# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-03-12

### Added

- **CalDAV integration** — Calendar event polling via CalDAV (Google OAuth + Basic auth); events delivered to per-calendar message buses
- **Google OAuth flow** — `caldav__oauth_browser` tool opens OAuth in Chrome; tokens returned as copyable JSON for `secrets_set`
- **`get_datetime` MCP tool** — Returns current UTC datetime in ISO 8601 format
- **Bus statuses popup** — "Bus statuses" button in sidebar shows all buses with online/offline indicators
- **`is_connected` in `list_buses`** — Each bus now reports connection status (Telegram/mail/CalDAV/root)
- **Calendar URL in bus properties** — CalDAV calendar URL saved to `properties.md` for each calendar bus
- **Bus properties `url` field** — `BusProperties` type extended with optional `url`; persisted to `properties.md`

### Changed

- **CalDAV bus IDs** — Now based on calendar display name (`caldav-{account}-{displayName}`) instead of URL path; more readable and stable across reconnects
- **CalDAV bus creation** — All calendar buses (including empty ones) are created with `properties.md` on connect, not only when the first event arrives
- **Stale CalDAV bus cleanup** — On each connect, buses for renamed/removed calendars are automatically wiped; their `lastKnownEvents` entries are also purged so events re-download under the new bus ID
- **Telegram App ID/Hash and Google OAuth credentials** — Hardcoded into the app; removed from config UI and `McpConfig` type
- **CalDAV hash** — Replaced 32-bit djb2 `simpleHash` with SHA-256 (16-char hex slice) for collision-resistant event change detection
- **`caldavInitAndWatch` return type** — Now returns `{ calendars: { busId, displayName, url }[] }` instead of `{ busIds }` for richer caller use
- **Root timeline formatting** — Bus-prefixed messages now use per-type emoji (📱 Telegram, 📧 Email, 📅 CalDAV); `[bus_id]` prefix removed from assistant messages
- **Message timestamps** — All live-pushed messages now include `timestamp` for correct timeline sorting and display

### Fixed

- **Telegram duplicate messages** — `handleNewMessage` was being registered multiple times across reconnects because `onNewMessage.add()` doesn't return an unsubscribe function; fixed with explicit `.remove()` fallback and a secondary content+timestamp dedup map (`deliveredContentKeys`) that catches cases where the same message arrives with different IDs (live stream vs catch-up difference)
- **Literal `\n` in agent messages** — Models that output `\n` as a two-character escape sequence (e.g. Gemini via OpenRouter) now have them normalized to real newlines in `send_message`
- **`formatTimestamp` invalid date** — `new Date()` never throws; replaced try/catch with `isNaN(d.getTime())` check
- **`agentInjectedQueue` not cleared on stop** — Queue is now cleared when chat is stopped, preventing stale injected messages from leaking into the next session
- **`busesDeliveredSinceRootWipe` not cleared on stop** — Set is now cleared on stop so first-from-bus context summaries are re-generated correctly on the next session

### Removed

- **Telegram App ID, App Hash, Google OAuth Client ID/Secret from config** — These are now hardcoded constants; the fields are gone from the config form and type definitions

### Migration

- **`migrate:caldav-bus-ids`** — Run `npm run migrate:caldav-bus-ids` once to delete old URL-based `caldav-*` history directories; they will be re-created under display-name-based IDs on next CalDAV connect

## [0.4.8] - 2025-03-11

### Added

- **delete_scheduled_task** — MCP tool to cancel a scheduled task by id (from list_tasks)

### Changed

- **Unified history format** — All message bus data in KB: `kb/history/{mb_id}/{date}/{seq}.md` for messages, `kb/history/{mb_id}/properties.md` for bus metadata
- **Startup task** — Now includes resume instructions for due scheduled tasks. Default instructions mention resuming tasks that were due while the app was closed
- **Startup prompt** — When due schedules exist, they are merged into the startup message instead of being sent separately
- **Telegram** — Missed messages use correct message timestamps for history (no longer wrong date folder)
- **Telegram** — delete_bus now deletes the chat from Telegram via mtcute (requires Telegram connected)
- **KB/QMD get** — Logging now correctly shows content when QMD returns `resource` type (was showing "(empty)")

### Removed

- **yaaia/mb** — Bus metadata moved to KB. Run `npm run migrate:history` once when upgrading
- **Message Buses editor** — Removed from UI; buses managed via KB and MCP tools

### Fixed

- **Telegram missed messages** — Filter out duplicate (last message) when minDate is inclusive; timestamp now advances correctly
- **Telegram history** — Messages stored under correct date path using message timestamp

### Migration

- **migrate:history** — Script migrates old `kb/history/YYYY-MM-DD/{bus_id}/` and `yaaia/mb/` to new `kb/history/{mb_id}/{date}/` format. Run `npm run migrate:history` once.

## [0.2.0] - 2025-03-04

### Added

- **Knowledge Base (KB)** — On-device search over markdown files using [QMD](https://github.com/tobi/qmd)
  - **KB Editor** — Create, edit, and delete `.md` / `.qmd` files in `~/yaaia/kb`
  - **File operations** — `kb__write`, `kb__delete`, `kb__list` for managing KB content
  - **Collections** — `kb__qmd_collection_add`, `kb__qmd_collection_list`, `kb__qmd_collection_remove` to index folders
  - **Search** — `kb__qmd_search` (BM25), `kb__qmd_vector_search`, `kb__qmd_deep_search` (query expansion + reranking)
  - **Retrieval** — `kb__qmd_get`, `kb__qmd_multi_get` for document content
  - **Indexing** — `kb__qmd_status`, `kb__qmd_update`, `kb__qmd_embed`
- All KB and QMD data stored under `~/yaaia` (kb content, qmd cache, config, models)
- MCP integration with QMD for hybrid search (keyword + vector + LLM reranking)
- **KB Editor** — Full-screen layout; Preview button to view rendered markdown
- **Inject message** — Send button becomes "Inject" during task; inject messages after last tool result

### Fixed

- QMD MCP server now uses correct database path via `INDEX_PATH` (was defaulting to `index.sqlite` instead of `yaaia.sqlite`)
- `kb__qmd_get` and `kb__qmd_multi_get` now return document content correctly (handles `resource` content type)
- Startup milestone "Agent browser ready" now shows green checkmark when last step
- IMAP socket timeout no longer crashes app (error handler + 10 min timeout)
