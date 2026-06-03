import initSqlJs from "sql.js";
import { App, normalizePath } from "obsidian";
import type { IndexedNote } from "./vault-index";
import { cosine } from "./embedder";
import { log, warn, error } from "./log";

const CACHE_FOLDER = ".fyp-cache";
const DB_FILE = "embeddings.db";

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

    db.run(`
      CREATE TABLE IF NOT EXISTS embeddings (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        preview TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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
          db.run(
            `INSERT OR REPLACE INTO embeddings (path, mtime, embedding, preview)
             VALUES (?, ?, ?, ?)`,
            [path, note.mtime, embeddingBuffer, note.preview]
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
      const stmt = db.prepare("SELECT path, mtime, embedding, preview FROM embeddings");
      const notes = new Map<string, IndexedNote>();
      let rowCount = 0;
      while (stmt.step()) {
        try {
          const row = stmt.getAsObject();
          const embedding = row.embedding as Uint8Array;
          if (rowCount < 3) {
            log(`[cache] load: row ${rowCount + 1}: path="${row.path}", embedding type=${typeof embedding}, length=${(embedding as any)?.length}`);
          }
          notes.set(row.path as string, {
            path: row.path as string,
            mtime: row.mtime as number,
            embedding: this.decodeEmbedding(embedding),
            preview: row.preview as string,
          });
          rowCount++;
        } catch (e) {
          error(`[cache] load: failed to decode row ${rowCount}:`, e);
          throw e;
        }
      }
      stmt.free();

      log(`[cache] loaded ${notes.size} embeddings from SQLite (processed ${rowCount} rows)`);
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
      const results: Array<{ path: string; score: number; preview: string }> = [];

      let rowCount = 0;
      while (stmt.step()) {
        try {
          const row = stmt.getAsObject();
          const path = row.path as string;
          if (path === excludePath) continue;
          const emb = this.decodeEmbedding(row.embedding as Uint8Array);
          const score = cosine(embedding, emb);
          results.push({ path, score, preview: row.preview as string });
          rowCount++;
        } catch (e) {
          error(`[cache] queryByEmbedding: failed to process row:`, e);
          throw e;
        }
      }
      stmt.free();

      results.sort((a, b) => b.score - a.score);
      const topK = results.slice(0, k);
      log(`[cache] queryByEmbedding: processed ${rowCount} rows, returning top ${topK.length}`);
      return topK;
    } catch (e) {
      error("[cache] queryByEmbedding failed:", e);
      return [];
    }
  }

  async getNote(path: string): Promise<IndexedNote | null> {
    try {
      log(`[cache] getNote: path="${path}"`);
      const db = await this.getDb();
      const stmt = db.prepare("SELECT path, mtime, embedding, preview FROM embeddings WHERE path = ?");
      stmt.bind([path]);
      if (!stmt.step()) {
        log(`[cache] getNote: note not found`);
        stmt.free();
        return null;
      }
      const row = stmt.getAsObject();
      log(`[cache] getNote: found, embedding length=${(row.embedding as any)?.length}`);
      stmt.free();

      return {
        path: row.path as string,
        mtime: row.mtime as number,
        embedding: this.decodeEmbedding(row.embedding as Uint8Array),
        preview: row.preview as string,
      };
    } catch (e) {
      error("[cache] getNote failed:", e);
      return null;
    }
  }

  async updateNote(path: string, note: IndexedNote): Promise<void> {
    try {
      const db = await this.getDb();
      const embeddingBuffer = this.encodeEmbedding(note.embedding);
      log(`[cache] updateNote: path="${path}", embedding length=${note.embedding.length}, buffer=${embeddingBuffer.byteLength} bytes`);
      db.run(
        `INSERT OR REPLACE INTO embeddings (path, mtime, embedding, preview)
         VALUES (?, ?, ?, ?)`,
        [path, note.mtime, embeddingBuffer, note.preview]
      );
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
      const stmt = db.prepare("SELECT COUNT(*) as count FROM embeddings");
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
      const stmt = db.prepare("SELECT path, mtime, embedding, preview FROM embeddings");
      const notes = new Map<string, IndexedNote>();

      while (stmt.step()) {
        const row = stmt.getAsObject();
        notes.set(row.path as string, {
          path: row.path as string,
          mtime: row.mtime as number,
          embedding: this.decodeEmbedding(row.embedding as Uint8Array),
          preview: row.preview as string,
        });
      }
      stmt.free();
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
