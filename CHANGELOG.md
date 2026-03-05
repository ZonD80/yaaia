# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
