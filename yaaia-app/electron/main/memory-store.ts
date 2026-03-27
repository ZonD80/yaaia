/**
 * Global agent memory — SQLite in history.db, FTS5 + LIKE for memory.find (v1).
 * Phase 2: semantic/vector search may extend memory.find.
 */

import type BetterSqlite3 from "better-sqlite3";

export type MemoryProvenance = {
  source_bus_id?: string;
  /** SQLite messages.id; use 0 in API for “current assistant message” (resolved by host). */
  source_db_id?: number;
  source_external_message_id?: string;
  source_contact_id?: string;
  provenance_note?: string;
  references_memory_ids?: number[];
};

export type MemoryEntry = {
  id: number;
  kind: string;
  body: string;
  tags: string[];
  key?: string;
  provenance: MemoryProvenance;
  captured_at: string;
  updated_at: string;
};

export type PendingMemoryRow = {
  tempId: number;
  entry: Omit<MemoryEntry, "id"> & { id: number };
};

let tempIdSeq = -1;

function nextTempId(): number {
  tempIdSeq -= 1;
  return tempIdSeq;
}

/** In-memory rows for source_db_id === 0 before assistant messages.id is known. */
export type MemoryEvalBuffers = {
  pending: PendingMemoryRow[];
};

/** Passed from agent-eval into direct-tools for each ts eval run. */
export type MemoryEvalContext = {
  buffers: MemoryEvalBuffers;
  assistantDbId?: number;
  triggeringUserDbId?: number;
};

export function createMemoryEvalBuffers(): MemoryEvalBuffers {
  return { pending: [] };
}

export function clearMemoryEvalBuffers(b: MemoryEvalBuffers): void {
  b.pending.length = 0;
}

export function migrateMemorySchema(db: InstanceType<typeof BetterSqlite3>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_bus_id TEXT,
      source_db_id INTEGER,
      source_external_message_id TEXT,
      source_contact_id TEXT,
      provenance_note TEXT,
      references_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      agent_key TEXT UNIQUE,
      captured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_kind ON agent_memories(kind);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_source_bus ON agent_memories(source_bus_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_source_db ON agent_memories(source_db_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_captured ON agent_memories(captured_at);
  `);

  const hasFts = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memories_fts'")
    .get() as { 1: number } | undefined;
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE agent_memories_fts USING fts5(
        body,
        content='agent_memories',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS agent_memories_ai AFTER INSERT ON agent_memories BEGIN
        INSERT INTO agent_memories_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_memories_ad AFTER DELETE ON agent_memories BEGIN
        INSERT INTO agent_memories_fts(agent_memories_fts, rowid, body) VALUES('delete', old.id, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_memories_au AFTER UPDATE ON agent_memories BEGIN
        INSERT INTO agent_memories_fts(agent_memories_fts, rowid, body) VALUES('delete', old.id, old.body);
        INSERT INTO agent_memories_fts(rowid, body) VALUES (new.id, new.body);
      END;
    `);
    const existing = db.prepare("SELECT id, body FROM agent_memories").all() as { id: number; body: string }[];
    const ins = db.prepare("INSERT INTO agent_memories_fts(rowid, body) VALUES (?, ?)");
    for (const r of existing) {
      ins.run(r.id, r.body);
    }
  }
}

const MEMORY_HELP_KEY = "memory_help";

export function getMemoryHelpText(db: InstanceType<typeof BetterSqlite3>): string {
  const row = db.prepare("SELECT value FROM agent_meta WHERE key = ?").get(MEMORY_HELP_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? "";
}

export function setMemoryHelpText(db: InstanceType<typeof BetterSqlite3>, text: string): void {
  db.prepare(
    "INSERT INTO agent_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(MEMORY_HELP_KEY, text);
}

function parseRow(row: {
  id: number;
  kind: string;
  body: string;
  tags_json: string;
  source_bus_id: string | null;
  source_db_id: number;
  source_external_message_id: string | null;
  source_contact_id: string | null;
  provenance_note: string | null;
  references_memory_ids_json: string;
  agent_key: string | null;
  captured_at: string;
  updated_at: string;
}): MemoryEntry {
  let tags: string[] = [];
  let refs: number[] = [];
  try {
    tags = JSON.parse(row.tags_json) as string[];
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }
  try {
    refs = JSON.parse(row.references_memory_ids_json) as number[];
    if (!Array.isArray(refs)) refs = [];
  } catch {
    refs = [];
  }
  const prov: MemoryProvenance = {
    ...(row.source_bus_id != null && row.source_bus_id !== "" ? { source_bus_id: row.source_bus_id } : {}),
    ...(row.source_db_id != null && row.source_db_id >= 1 ? { source_db_id: row.source_db_id } : {}),
    ...(row.source_external_message_id ? { source_external_message_id: row.source_external_message_id } : {}),
    ...(row.source_contact_id ? { source_contact_id: row.source_contact_id } : {}),
    ...(row.provenance_note ? { provenance_note: row.provenance_note } : {}),
    ...(refs.length > 0 ? { references_memory_ids: refs } : {}),
  };
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    tags,
    ...(row.agent_key ? { key: row.agent_key } : {}),
    provenance: prov,
    captured_at: row.captured_at,
    updated_at: row.updated_at,
  };
}

function validateReferences(db: InstanceType<typeof BetterSqlite3>, ids: number[]): string | null {
  if (ids.length === 0) return null;
  const chk = db.prepare("SELECT 1 FROM agent_memories WHERE id = ?");
  for (const id of ids) {
    if (!chk.get(id)) return `references_memory_ids: id ${id} does not exist`;
  }
  return null;
}

export type MemoryPutInput = {
  kind?: string;
  body: string;
  tags?: string[];
  key?: string;
  provenance?: MemoryProvenance;
};

function resolveSourceDbId(
  raw: number | undefined,
  opts: { assistantDbId?: number; triggeringUserDbId?: number }
): { sql: number | null; pending: boolean } {
  if (raw === undefined || raw === null) return { sql: null, pending: false };
  if (raw === 0) {
    if (opts.assistantDbId != null && opts.assistantDbId >= 1) {
      return { sql: opts.assistantDbId, pending: false };
    }
    return { sql: null, pending: true };
  }
  return { sql: raw, pending: false };
}

export function memoryPut(
  db: InstanceType<typeof BetterSqlite3>,
  input: MemoryPutInput,
  buffers: MemoryEvalBuffers,
  opts: { assistantDbId?: number; triggeringUserDbId?: number }
): { ok: true; id: number } | { ok: false; error: string } {
  const kind = input.kind ?? "";
  const body = String(input.body ?? "");
  if (!body.trim()) return { ok: false, error: "body is required" };
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  const prov = input.provenance ?? {};
  const refs = prov.references_memory_ids ?? [];
  const err = validateReferences(db, refs);
  if (err) return { ok: false, error: err };

  const srcBus = prov.source_bus_id != null ? String(prov.source_bus_id) : null;
  const rawDb = prov.source_db_id;
  const resolved = resolveSourceDbId(rawDb, opts);
  const ext = prov.source_external_message_id != null ? String(prov.source_external_message_id) : null;
  const contact = prov.source_contact_id != null ? String(prov.source_contact_id) : null;
  const note = prov.provenance_note != null ? String(prov.provenance_note) : null;

  if (resolved.pending) {
    const keyTrim = input.key != null ? String(input.key).trim() : "";
    if (keyTrim) {
      const existing = db.prepare("SELECT id FROM agent_memories WHERE agent_key = ?").get(keyTrim) as { id: number } | undefined;
      if (existing) {
        return { ok: false, error: "key already exists in storage; cannot upsert pending row with same key" };
      }
      const dupPending = buffers.pending.some((p) => p.entry.key === keyTrim);
      if (dupPending) return { ok: false, error: "duplicate key in pending buffer" };
    }
    const now = new Date().toISOString();
    const synthetic: MemoryEntry = {
      id: nextTempId(),
      kind,
      body,
      tags,
      ...(keyTrim ? { key: keyTrim } : {}),
      provenance: {
        ...prov,
        source_db_id: 0,
      },
      captured_at: now,
      updated_at: now,
    };
    buffers.pending.push({ tempId: synthetic.id, entry: synthetic });
    return { ok: true, id: synthetic.id };
  }

  const sourceDb = resolved.sql;
  const keyTrim = input.key != null ? String(input.key).trim() : "";

  if (keyTrim) {
    const existing = db.prepare("SELECT id FROM agent_memories WHERE agent_key = ?").get(keyTrim) as
      | { id: number }
      | undefined;
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(tags);
    if (existing) {
      db.prepare(`UPDATE agent_memories SET kind = ?, body = ?, tags_json = ?, updated_at = ? WHERE id = ?`).run(
        kind,
        body,
        tagsJson,
        now,
        existing.id
      );
      return { ok: true, id: existing.id };
    }
    const refsJson = JSON.stringify(refs);
    const r = db
      .prepare(
        `INSERT INTO agent_memories (
        kind, body, tags_json, source_bus_id, source_db_id, source_external_message_id, source_contact_id,
        provenance_note, references_memory_ids_json, agent_key, captured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        kind,
        body,
        tagsJson,
        srcBus,
        sourceDb,
        ext,
        contact,
        note,
        refsJson,
        keyTrim,
        now,
        now
      );
    return { ok: true, id: Number(r.lastInsertRowid) };
  }

  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(tags);
  const refsJson = JSON.stringify(refs);
  const r = db
    .prepare(
      `INSERT INTO agent_memories (
      kind, body, tags_json, source_bus_id, source_db_id, source_external_message_id, source_contact_id,
      provenance_note, references_memory_ids_json, agent_key, captured_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(kind, body, tagsJson, srcBus, sourceDb, ext, contact, note, refsJson, now, now);
  return { ok: true, id: Number(r.lastInsertRowid) };
}

/** After assistant row exists, persist pending rows with real source_db_id. */
export function flushPendingMemoryRows(
  db: InstanceType<typeof BetterSqlite3>,
  buffers: MemoryEvalBuffers,
  assistantDbId: number
): void {
  if (assistantDbId < 1 || buffers.pending.length === 0) return;
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO agent_memories (
      kind, body, tags_json, source_bus_id, source_db_id, source_external_message_id, source_contact_id,
      provenance_note, references_memory_ids_json, agent_key, captured_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of buffers.pending) {
    const e = p.entry;
    const prov = e.provenance;
    const refs = prov.references_memory_ids ?? [];
    const tagsJson = JSON.stringify(e.tags);
    const refsJson = JSON.stringify(refs);
    const srcBus = prov.source_bus_id != null ? String(prov.source_bus_id) : null;
    const ext = prov.source_external_message_id != null ? String(prov.source_external_message_id) : null;
    const contact = prov.source_contact_id != null ? String(prov.source_contact_id) : null;
    const note = prov.provenance_note != null ? String(prov.provenance_note) : null;
    ins.run(
      e.kind,
      e.body,
      tagsJson,
      srcBus,
      assistantDbId,
      ext,
      contact,
      note,
      refsJson,
      e.key ?? null,
      e.captured_at,
      now
    );
  }
  buffers.pending.length = 0;
}

export function memoryGet(
  db: InstanceType<typeof BetterSqlite3>,
  id: number,
  buffers: MemoryEvalBuffers
): MemoryEntry | null {
  if (id < 0) {
    const p = buffers.pending.find((x) => x.entry.id === id);
    return p ? { ...p.entry } : null;
  }
  const row = db.prepare("SELECT * FROM agent_memories WHERE id = ?").get(id) as Parameters<typeof parseRow>[0] | undefined;
  return row ? parseRow(row) : null;
}

export type MemoryListFilter = {
  kind?: string;
  tags?: string[];
  body_substring?: string;
  source_bus_id?: string;
  source_contact_id?: string;
  /** Pass 0 to match pending assistant-linked rows during eval */
  source_db_id?: number;
  from_timestamp?: string;
  to_timestamp?: string;
  limit?: number;
  offset?: number;
};

function entryMatchesFilter(e: MemoryEntry, f: MemoryListFilter): boolean {
  if (f.kind != null && f.kind !== "" && e.kind !== f.kind) return false;
  if (f.body_substring && !e.body.includes(f.body_substring)) return false;
  if (f.source_bus_id != null && f.source_bus_id !== "" && e.provenance.source_bus_id !== f.source_bus_id) {
    return false;
  }
  if (f.source_contact_id != null && f.source_contact_id !== "" && e.provenance.source_contact_id !== f.source_contact_id) {
    return false;
  }
  if (f.source_db_id !== undefined) {
    const sid = e.provenance.source_db_id;
    if (f.source_db_id === 0) {
      if (sid !== 0) return false;
    } else if (sid !== f.source_db_id) return false;
  }
  if (f.tags && f.tags.length > 0) {
    for (const t of f.tags) {
      if (!e.tags.includes(t)) return false;
    }
  }
  if (f.from_timestamp && e.captured_at < f.from_timestamp) return false;
  if (f.to_timestamp && e.captured_at > f.to_timestamp) return false;
  return true;
}

export function memoryList(
  db: InstanceType<typeof BetterSqlite3>,
  f: MemoryListFilter,
  buffers: MemoryEvalBuffers
): MemoryEntry[] {
  const limit = Math.min(Math.max(1, f.limit ?? 50), 500);
  const offset = Math.max(0, f.offset ?? 0);
  const rows = db
    .prepare("SELECT * FROM agent_memories ORDER BY id DESC")
    .all() as Parameters<typeof parseRow>[0][];
  const parsed = rows.map(parseRow);
  const pending = buffers.pending.map((p) => ({ ...p.entry }));
  const merged = [...pending, ...parsed];
  merged.sort((a, b) => b.id - a.id);
  const filtered = merged.filter((e) => entryMatchesFilter(e, f));
  return filtered.slice(offset, offset + limit);
}

export function memoryDelete(
  db: InstanceType<typeof BetterSqlite3>,
  id: number,
  buffers: MemoryEvalBuffers
): boolean {
  if (id < 0) {
    const i = buffers.pending.findIndex((x) => x.entry.id === id);
    if (i >= 0) {
      buffers.pending.splice(i, 1);
      return true;
    }
    return false;
  }
  const r = db.prepare("DELETE FROM agent_memories WHERE id = ?").run(id);
  return r.changes > 0;
}

export type MemoryFindOptions = {
  query: string;
  /** fts = FTS5 MATCH (v1); like = SQL LIKE on body */
  mode?: "fts" | "like";
  limit?: number;
};

export function memoryFind(
  db: InstanceType<typeof BetterSqlite3>,
  options: MemoryFindOptions,
  buffers: MemoryEvalBuffers
): MemoryEntry[] {
  const q = String(options.query ?? "").trim();
  const limit = Math.min(Math.max(1, options.limit ?? 20), 200);
  const mode = options.mode ?? "fts";
  let sqlIds: number[] = [];

  if (q) {
    if (mode === "like") {
      const rows = db
        .prepare("SELECT id FROM agent_memories WHERE body LIKE ? ORDER BY id DESC LIMIT ?")
        .all(`%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`, limit * 3) as { id: number }[];
      sqlIds = rows.map((r) => r.id);
    } else {
      try {
        const rows = db
          .prepare(
            `
          SELECT m.id FROM agent_memories m
          INNER JOIN agent_memories_fts fts ON fts.rowid = m.id
          WHERE agent_memories_fts MATCH ?
          ORDER BY m.id DESC
          LIMIT ?
        `
          )
          .all(q, limit * 3) as { id: number }[];
        sqlIds = rows.map((r) => r.id);
      } catch {
        const rows = db
          .prepare("SELECT id FROM agent_memories WHERE body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?")
          .all(`%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`, limit * 3) as { id: number }[];
        sqlIds = rows.map((r) => r.id);
      }
    }
  }

  const byId = new Map<number, MemoryEntry>();
  for (const id of sqlIds) {
    const row = db.prepare("SELECT * FROM agent_memories WHERE id = ?").get(id) as Parameters<typeof parseRow>[0] | undefined;
    if (row) byId.set(id, parseRow(row));
  }

  const pendingHits: MemoryEntry[] = [];
  if (q) {
    const needle = q.toLowerCase();
    for (const p of buffers.pending) {
      if (p.entry.body.toLowerCase().includes(needle)) pendingHits.push({ ...p.entry });
    }
  }

  const combined = [...pendingHits, ...[...byId.values()]];
  return combined.slice(0, limit);
}
