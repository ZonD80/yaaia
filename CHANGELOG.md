# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
