import initSqlJs from "sql.js";
import { App, normalizePath } from "obsidian";
import type { IndexedNote, NoteChunk } from "./vault-index";
import { cosine } from "./embedder";
import { log, warn, error } from "./log";

const CACHE_FOLDER = ".fyp-cache";
const DB_FILE = "embeddings.db";

/**
 * Collapse a note's per-chunk embeddings into a single note-level vector.
 * Chunk embeddings are unit-normalised by the model, so a single-chunk note is
 * returned unchanged; multi-chunk notes get the L2-normalised mean (centroid),
 * keeping the result a unit vector for the dot-product cosine.
 */
function meanPool(embeddings: number[][]): number[] {
  if (embeddings.length === 1) return embeddings[0];
  const dim = embeddings[0]?.length ?? 0;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let d = 0; d < dim; d++) centroid[d] += emb[d];
  }
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    centroid[d] /= embeddings.length;
    norm += centroid[d] * centroid[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) centroid[d] /= norm;
  return centroid;
}

export class CacheManager {
  private app: App;
  private pluginDir: string;
  private db: any = null;
  private sqlJs: any = null;

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.pluginDir = pluginDir;
  }

  private async ensureCacheFolder(): Promise<void> {
    const folderPath = normalizePath(CACHE_FOLDER);
    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.adapter.mkdir(folderPath);
    }
  }

  private async getSqlJs(): Promise<any> {
    if (this.sqlJs) return this.sqlJs;

    try {
      log(`[cache] getSqlJs: reading wasm binary`);
      const wasmPath = `${this.pluginDir}/sql-wasm-browser.wasm`;

      const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);
      log(`[cache] getSqlJs: loaded ${wasmBinary.byteLength} bytes of wasm`);

      this.sqlJs = await initSqlJs({ wasmBinary });
      log(`[cache] getSqlJs: initialized successfully`);
      return this.sqlJs;
    } catch (e) {
      error(`[cache] getSqlJs failed:`, e);
      throw e;
    }
  }

  private getDbPath(): string {
    return normalizePath(`${CACHE_FOLDER}/${DB_FILE}`);
  }

  private async getDb(): Promise<any> {
    if (this.db) return this.db;

    try {
      log(`[cache] getDb: starting`);
      await this.ensureCacheFolder();
      const sqlJs = await this.getSqlJs();

      const dbPath = this.getDbPath();
      if (await this.app.vault.adapter.exists(dbPath)) {
        log(`[cache] getDb: loading existing database from "${dbPath}"`);
        const fileData = await this.app.vault.adapter.readBinary(dbPath);
        log(`[cache] getDb: read ${fileData.byteLength} bytes`);
        this.db = new sqlJs.Database(new Uint8Array(fileData));
        log(`[cache] getDb: database loaded`);
      } else {
        log(`[cache] getDb: creating new database`);
        this.db = new sqlJs.Database();
      }

      this.initializeSchema();
      log(`[cache] getDb: schema initialized`);
      return this.db;
    } catch (e) {
      error(`[cache] getDb failed:`, e);
      throw e;
    }
  }

  private initializeSchema(): void {
    const db = this.db!;

    // Migrate pre-chunking caches: the old schema keyed embeddings on path alone
    // (one vector per note). Drop it so the vault is re-indexed into chunk rows.
    try {
      const info = db.exec("PRAGMA table_info(embeddings)");
      if (info.length > 0) {
        const cols = info[0].values.map((row: unknown[]) => row[1]);
        if (!cols.includes("chunk_idx")) {
          log("[cache] migrating: dropping pre-chunking embeddings table");
          db.run("DROP TABLE embeddings");
        }
      }
    } catch (e) {
      warn("[cache] schema migration check failed:", e);
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS embeddings (
        path TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        preview TEXT NOT NULL,
        PRIMARY KEY (path, chunk_idx)
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_embeddings_path ON embeddings(path);
      CREATE INDEX IF NOT EXISTS idx_embeddings_mtime ON embeddings(mtime);
    `);
  }

  private async saveDb(): Promise<void> {
    if (!this.db) return;
    try {
      const t0 = performance.now();
      const data = this.db.export();
      const dbPath = this.getDbPath();
      await this.app.vault.adapter.writeBinary(dbPath, data);
      log(`[cache] saveDb: ${data.byteLength} bytes in ${(performance.now() - t0).toFixed(0)}ms`);
    } catch (e) {
      error(`[cache] saveDb failed:`, e);
      throw e;
    }
  }

  private encodeEmbedding(embedding: number[]): Uint8Array {
    const data = new Uint8Array(embedding.length * 4);
    const view = new Float32Array(data.buffer);
    for (let i = 0; i < embedding.length; i++) {
      view[i] = embedding[i];
    }
    return data;
  }

  private decodeEmbedding(data: Uint8Array): number[] {
    if (!data) {
      warn(`[cache] decodeEmbedding: data is null/undefined`);
      return [];
    }
    if (!(data instanceof Uint8Array)) {
      warn(`[cache] decodeEmbedding: data is ${typeof data}, not Uint8Array`);
      data = new Uint8Array(data);
    }

    const byteLength = data.length;
    const floatCount = byteLength / 4;
    if (byteLength % 4 !== 0) {
      warn(`[cache] decodeEmbedding: byteLength ${byteLength} not divisible by 4`);
    }

    try {
      const view = new Float32Array(data.buffer, data.byteOffset, floatCount);
      return Array.from(view);
    } catch (e) {
      error(`[cache] decodeEmbedding failed:`, e);
      return [];
    }
  }

  async save(notes: Map<string, IndexedNote>, modelPath: string): Promise<void> {
    try {
      log(`[cache] save: starting with ${notes.size} notes`);
      const db = await this.getDb();

      let count = 0;
      for (const [path, note] of notes) {
        try {
          const embeddingBuffer = this.encodeEmbedding(note.embedding);
          if (count < 3 || count % 100 === 0) {
            log(`[cache] save: inserting note ${count + 1}/${notes.size}: "${path}" (embedding length: ${note.embedding.length}, buffer: ${embeddingBuffer.byteLength} bytes)`);
          }
          db.run("DELETE FROM embeddings WHERE path = ?", [path]);
          db.run(
            `INSERT OR REPLACE INTO embeddings (path, chunk_idx, mtime, embedding, preview)
             VALUES (?, ?, ?, ?, ?)`,
            [path, 0, note.mtime, embeddingBuffer, note.preview]
          );
          count++;
        } catch (e) {
          error(`[cache] save: failed on note "${path}":`, e);
          throw e;
        }
      }

      log(`[cache] save: inserted ${count} notes, now saving metadata`);
      db.run(
        `INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`,
        ["modelPath", modelPath]
      );

      await this.saveDb();
      log(`[cache] saved ${notes.size} embeddings to SQLite`);
    } catch (e) {
      error("[cache] save failed:", e);
    }
  }

  async load(modelPath: string): Promise<Map<string, IndexedNote> | null> {
    try {
      log(`[cache] load: starting with modelPath="${modelPath}"`);
      const db = await this.getDb();

      const metaStmt = db.prepare("SELECT value FROM metadata WHERE key = ?");
      log(`[cache] load: prepared metadata statement`);
      metaStmt.bind(["modelPath"]);
      log(`[cache] load: bound modelPath parameter`);

      const hasMeta = metaStmt.step();
      log(`[cache] load: hasMeta=${hasMeta}`);
      const meta = hasMeta ? metaStmt.getAsObject() : null;
      log(`[cache] load: meta=${JSON.stringify(meta)}`);
      metaStmt.free();

      if (!meta || (meta as { value: string }).value !== modelPath) {
        const oldPath = meta ? (meta as { value: string }).value : null;
        log(
          `[cache] model path changed${oldPath ? ` (was "${oldPath}", now "${modelPath}")` : ""}, clearing cache`
        );
        await this.clear();
        return null;
      }

      log(`[cache] load: preparing embeddings query`);
      const stmt = db.prepare(
        "SELECT path, chunk_idx, mtime, embedding, preview FROM embeddings ORDER BY path, chunk_idx"
      );
      const grouped = new Map<string, { mtime: number; preview: string; embs: number[][] }>();
      let rowCount = 0;
      while (stmt.step()) {
        try {
          const row = stmt.getAsObject();
          const path = row.path as string;
          let g = grouped.get(path);
          if (!g) {
            g = { mtime: row.mtime as number, preview: "", embs: [] };
            grouped.set(path, g);
          }
          if ((row.chunk_idx as number) === 0) g.preview = row.preview as string;
          g.embs.push(this.decodeEmbedding(row.embedding as Uint8Array));
          rowCount++;
        } catch (e) {
          error(`[cache] load: failed to decode row ${rowCount}:`, e);
          throw e;
        }
      }
      stmt.free();

      const notes = new Map<string, IndexedNote>();
      for (const [path, g] of grouped) {
        notes.set(path, { path, mtime: g.mtime, embedding: meanPool(g.embs), preview: g.preview });
      }

      log(`[cache] loaded ${notes.size} notes from SQLite (processed ${rowCount} chunk rows)`);
      return notes;
    } catch (e) {
      log(`[cache] no valid cache found:`, e instanceof Error ? e.message : "unknown error");
      error(`[cache] load error details:`, e);
      return null;
    }
  }

  async queryByEmbedding(embedding: number[], k: number, excludePath?: string): Promise<Array<{ path: string; score: number; preview: string }>> {
    try {
      log(`[cache] queryByEmbedding: query embedding length=${embedding.length}, k=${k}, excludePath="${excludePath}"`);
      const db = await this.getDb();
      const stmt = db.prepare("SELECT path, embedding, preview FROM embeddings");
      const best = new Map<string, { score: number; preview: string }>();

      let rowCount = 0;
      while (stmt.step()) {
        try {
          const row = stmt.getAsObject();
          const path = row.path as string;
          if (path === excludePath) continue;
          const emb = this.decodeEmbedding(row.embedding as Uint8Array);
          const score = cosine(embedding, emb);
          const current = best.get(path);
          if (!current || score > current.score) {
            best.set(path, { score, preview: row.preview as string });
          }
          rowCount++;
        } catch (e) {
          error(`[cache] queryByEmbedding: failed to process row:`, e);
          throw e;
        }
      }
      stmt.free();

      const results = Array.from(best, ([path, v]) => ({ path, score: v.score, preview: v.preview }));
      results.sort((a, b) => b.score - a.score);
      const topK = results.slice(0, k);
      log(`[cache] queryByEmbedding: processed ${rowCount} chunk rows, returning top ${topK.length}`);
      return topK;
    } catch (e) {
      error("[cache] queryByEmbedding failed:", e);
      return [];
    }
  }

  async getNote(path: string): Promise<IndexedNote | null> {
    try {
      const db = await this.getDb();
      const stmt = db.prepare(
        "SELECT chunk_idx, mtime, embedding, preview FROM embeddings WHERE path = ? ORDER BY chunk_idx"
      );
      stmt.bind([path]);
      const embs: number[][] = [];
      let mtime = 0;
      let preview = "";
      while (stmt.step()) {
        const row = stmt.getAsObject();
        mtime = row.mtime as number;
        if ((row.chunk_idx as number) === 0) preview = row.preview as string;
        embs.push(this.decodeEmbedding(row.embedding as Uint8Array));
      }
      stmt.free();

      if (embs.length === 0) return null;
      return { path, mtime, embedding: meanPool(embs), preview };
    } catch (e) {
      error("[cache] getNote failed:", e);
      return null;
    }
  }

  async updateNote(path: string, mtime: number, chunks: NoteChunk[]): Promise<void> {
    try {
      const db = await this.getDb();
      log(`[cache] updateNote: path="${path}", ${chunks.length} chunk(s)`);
      db.run("DELETE FROM embeddings WHERE path = ?", [path]);
      chunks.forEach((chunk, idx) => {
        db.run(
          `INSERT OR REPLACE INTO embeddings (path, chunk_idx, mtime, embedding, preview)
           VALUES (?, ?, ?, ?, ?)`,
          [path, idx, mtime, this.encodeEmbedding(chunk.embedding), chunk.preview]
        );
      });
    } catch (e) {
      error("[cache] updateNote failed:", e);
    }
  }

  async removeNote(path: string): Promise<void> {
    try {
      const db = await this.getDb();
      db.run("DELETE FROM embeddings WHERE path = ?", [path]);
    } catch (e) {
      error("[cache] removeNote failed:", e);
      // don't throw - this is a background operation
    }
  }

  async flush(): Promise<void> {
    await this.saveDb();
  }

  async getNoteCount(): Promise<number> {
    try {
      const db = await this.getDb();
      const stmt = db.prepare("SELECT COUNT(DISTINCT path) as count FROM embeddings");
      stmt.step();
      const result = stmt.getAsObject();
      stmt.free();
      return (result.count as number) || 0;
    } catch (e) {
      error("[cache] getNoteCount failed:", e);
      return 0;
    }
  }

  async getAllNotes(): Promise<Map<string, IndexedNote>> {
    try {
      const db = await this.getDb();
      const stmt = db.prepare(
        "SELECT path, chunk_idx, mtime, embedding, preview FROM embeddings ORDER BY path, chunk_idx"
      );
      const grouped = new Map<string, { mtime: number; preview: string; embs: number[][] }>();

      while (stmt.step()) {
        const row = stmt.getAsObject();
        const path = row.path as string;
        let g = grouped.get(path);
        if (!g) {
          g = { mtime: row.mtime as number, preview: "", embs: [] };
          grouped.set(path, g);
        }
        if ((row.chunk_idx as number) === 0) g.preview = row.preview as string;
        g.embs.push(this.decodeEmbedding(row.embedding as Uint8Array));
      }
      stmt.free();

      const notes = new Map<string, IndexedNote>();
      for (const [path, g] of grouped) {
        notes.set(path, { path, mtime: g.mtime, embedding: meanPool(g.embs), preview: g.preview });
      }
      return notes;
    } catch (e) {
      error("[cache] getAllNotes failed:", e);
      return new Map();
    }
  }

  async saveModelPath(modelPath: string): Promise<void> {
    try {
      const db = await this.getDb();
      db.run(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, ["modelPath", modelPath]);
      await this.saveDb();
    } catch (e) {
      error("[cache] saveModelPath failed:", e);
    }
  }

  async clear(): Promise<void> {
    try {
      const dbFilePath = this.getDbPath();
      if (await this.app.vault.adapter.exists(dbFilePath)) {
        await this.app.vault.adapter.remove(dbFilePath);
      }
      this.db = null;
      log("[cache] cleared");
    } catch (e) {
      error("[cache] clear failed:", e);
    }
  }

  close(): void {
    this.db = null;
  }
}
