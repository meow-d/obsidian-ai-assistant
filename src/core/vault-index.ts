import { App, TFile } from "obsidian";
import { embed, initEmbedder, setEmbedderStatusCallback } from "./embedder";
import type { CacheManager } from "./cache-manager";
import { log } from "./log";

export interface IndexedNote {
  path: string;
  mtime: number;
  embedding: number[];
  preview: string;
}

export interface SearchResult {
  file: TFile;
  score: number;
  preview: string;
}

// Matches [[target]], [[target|alias]], [[target#heading|alias]], [[target^block]]
const WL_RE = /\[\[([^\[\]|#^]+?)(?:[#^][^\[\]|]*)?(?:\|([^\[\]]*))?\]\]/g;

/**
 * Mirror of the Python pipeline's clean_frontmatter + resolve_wikilinks steps.
 *
 * - Strips the original frontmatter and rebuilds it with title, tags, aliases only.
 * - Replaces [[wikilinks]] with their display text; when resolveWikilink is provided,
 *   broken links (resolver returns null) are dropped (→ "") matching Python behaviour.
 * - H1 headings are left in place (Python does not strip them).
 */
export function prepareNoteText(
  raw: string,
  title?: string,
  tags: string[] = [],
  aliases: string[] = [],
  resolveWikilink?: (target: string) => string | null,
): string {
  // Strip original frontmatter
  const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
  const fmMatch = FM_RE.exec(raw);
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

  // Rebuild cleaned frontmatter (title + kept keys only — mirrors Python KEEP_KEYS)
  const fmLines: string[] = [];
  if (title) fmLines.push(`title: ${title}`);
  if (tags.length > 0) {
    fmLines.push("tags:");
    for (const t of tags) fmLines.push(`  - ${t}`);
  }
  if (aliases.length > 0) {
    fmLines.push("aliases:");
    for (const a of aliases) fmLines.push(`  - ${a}`);
  }
  const fmBlock = fmLines.length > 0 ? `---\n${fmLines.join("\n")}\n---\n` : "";

  // Normalise wikilinks: resolved → display label, broken → "" (when resolver provided)
  const normalised = body.replace(WL_RE, (_, target: string, alias?: string) => {
    const display = (alias?.trim() || target?.trim()) ?? "";
    if (resolveWikilink) return resolveWikilink(target.trim()) !== null ? display : "";
    return display;
  });

  return fmBlock + normalised;
}

function extractPreviewText(prepared: string): string {
  const FM_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;
  const content = prepared.replace(FM_RE, "").trim();
  return content.slice(0, 200).replace(/\n/g, " ");
}

export class VaultIndex {
  private app: App;
  private modelPath: string;
  private cacheManager: CacheManager | null;
  // adjacency list: path → set of linked paths (only in-memory data)
  private wikilinkGraph: Map<string, Set<string>> = new Map();
  private pathCache: Set<string> = new Set();
  private indexSize: number = 0;

  constructor(app: App, modelPath: string, cacheManager?: CacheManager) {
    this.app = app;
    this.modelPath = modelPath;
    this.cacheManager = cacheManager || null;
  }

  async build(onProgress?: (current: number, total: number) => void, onStatus?: (msg: string) => void): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    log(`[index] build() called: ${files.length} files to index`);
    const t0 = performance.now();
    setEmbedderStatusCallback(onStatus ?? null);
    await initEmbedder(this.modelPath || undefined);
    setEmbedderStatusCallback(null);

    // Load cached metadata to check mtime
    const cached = await this.cacheManager?.load(this.modelPath);
    const cachedNotes = cached || new Map();
    this.pathCache.clear();
    for (const path of cachedNotes.keys()) {
      this.pathCache.add(path);
    }

    log(`[index] loaded ${cachedNotes.size} from cache, checking for stale entries`);
    // Remove files that no longer exist in vault
    const filePaths = new Set(files.map((f) => f.path));
    for (const path of cachedNotes.keys()) {
      if (!filePaths.has(path)) {
        log(`[index] removing stale cached entry: "${path}"`);
        await this.cacheManager?.removeNote(path);
        this.pathCache.delete(path);
      }
    }

    // Index new/modified files
    const filesToIndex = files.filter((f) => {
      const cached = cachedNotes.get(f.path);
      return !cached || cached.mtime !== f.stat.mtime;
    });

    if (filesToIndex.length > 0) {
      log(`[index] indexing ${filesToIndex.length} new/modified files`);
      await this.indexFiles(filesToIndex, () => {
        // Report progress relative to total files
        onProgress?.(this.pathCache.size, files.length);
      });
    }

    this.buildWikilinkGraph(files);

    await this.cacheManager?.saveModelPath(this.modelPath);
    this.indexSize = await this.cacheManager?.getNoteCount() ?? 0;
    log(`[index] build() finished in ${(performance.now() - t0).toFixed(0)}ms, ${this.indexSize} notes in cache`);
  }

  private async indexFiles(files: TFile[], onProgress?: (current: number, total: number) => void): Promise<void> {
    const BATCH = 32;
    const totalBatches = Math.ceil(files.length / BATCH);
    let indexed = 0;
    for (let i = 0; i < files.length; i += BATCH) {
      const batchNum = Math.floor(i / BATCH) + 1;
      const batch = files.slice(i, i + BATCH);
      const t0 = performance.now();
      const raws = await Promise.all(batch.map((f) => this.app.vault.cachedRead(f)));
      const texts = raws.map((raw, j) => this.prepareText(batch[j], raw));
      const readMs = performance.now() - t0;
      const embeddings = await embed(texts);
      const totalMs = performance.now() - t0;
      log(`[index] batch ${batchNum}/${totalBatches}: ${batch.length} files, read=${readMs.toFixed(0)}ms, total=${totalMs.toFixed(0)}ms`);
      for (let j = 0; j < batch.length; j++) {
        const f = batch[j];
        const note: IndexedNote = {
          path: f.path,
          mtime: f.stat.mtime,
          embedding: embeddings[j],
          preview: extractPreviewText(texts[j]),
        };
        await this.cacheManager?.updateNote(f.path, note);
        this.pathCache.add(f.path);
        indexed++;
        onProgress?.(indexed, files.length);
      }
      await this.cacheManager?.flush();
    }
  }

  private prepareText(file: TFile, raw: string): string {
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = (cache?.tags ?? []).map((t) => t.tag.replace(/^#/, ""));
    const aliases: string[] = Array.isArray(cache?.frontmatter?.aliases)
      ? cache.frontmatter.aliases
      : cache?.frontmatter?.aliases ? [cache.frontmatter.aliases] : [];
    return prepareNoteText(raw, file.basename, tags, aliases, (target) => {
      const dest = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
      return dest ? dest.path : null;
    });
  }

  private buildWikilinkGraph(files: TFile[]): void {
    this.wikilinkGraph.clear();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const targets = new Set<string>();
      for (const link of cache?.links ?? []) {
        const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
        if (target) targets.add(target.path);
      }
      this.wikilinkGraph.set(file.path, targets);
    }
  }

  async updateFile(file: TFile): Promise<void> {
    const isNew = !this.pathCache.has(file.path);
    const t0 = performance.now();
    log(`[index] updateFile (${isNew ? "new" : "changed"}): "${file.path}"`);
    const raw = await this.app.vault.cachedRead(file);
    const text = this.prepareText(file, raw);
    const [emb] = await embed([text]);
    const note: IndexedNote = {
      path: file.path,
      mtime: file.stat.mtime,
      embedding: emb,
      preview: extractPreviewText(text),
    };
    await this.cacheManager?.updateNote(file.path, note);
    await this.cacheManager?.flush();
    this.pathCache.add(file.path);
    const cache = this.app.metadataCache.getFileCache(file);
    const targets = new Set<string>();
    for (const link of cache?.links ?? []) {
      const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (target) targets.add(target.path);
    }
    this.wikilinkGraph.set(file.path, targets);
    log(`[index] updateFile done in ${(performance.now() - t0).toFixed(0)}ms, links=${targets.size}`);
  }

  async removeFile(path: string): Promise<void> {
    log(`[index] removeFile: "${path}"${this.pathCache.has(path) ? "" : " (not in index)"}`);
    await this.cacheManager?.removeNote(path);
    await this.cacheManager?.flush();
    this.pathCache.delete(path);
    this.wikilinkGraph.delete(path);
  }

  async search(query: string, k: number, excludePath?: string): Promise<SearchResult[]> {
    log(`[index] search: query="${query}", k=${k}${excludePath ? `, exclude="${excludePath}"` : ""}, index_size=${this.pathCache.size}`);
    const [qEmb] = await embed([query]);
    const results = await this.searchByEmbedding(qEmb, k, excludePath);
    log(`[index] search: ${results.length} results, top="${results[0]?.file.basename}" (${results[0]?.score.toFixed(3) ?? "n/a"})`);
    return results;
  }

  async searchByEmbedding(emb: number[], k: number, excludePath?: string): Promise<SearchResult[]> {
    if (!this.cacheManager) return [];
    const results = await this.cacheManager.queryByEmbedding(emb, k, excludePath);
    return results.flatMap(({ path, score, preview }) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return [];
      return [{ file, score, preview }];
    });
  }

  async getEmbedding(path: string): Promise<number[] | undefined> {
    const note = await this.cacheManager?.getNote(path);
    return note?.embedding;
  }

  async getMtime(path: string): Promise<number> {
    const note = await this.cacheManager?.getNote(path);
    return note?.mtime ?? 0;
  }

  getOutLinks(path: string): Set<string> {
    return this.wikilinkGraph.get(path) ?? new Set();
  }

  getOneHopNeighbours(path: string): string[] {
    const out = this.wikilinkGraph.get(path) ?? new Set();
    const neighbours = new Set<string>(out);
    for (const [src, targets] of this.wikilinkGraph) {
      if (targets.has(path)) neighbours.add(src);
    }
    neighbours.delete(path);
    return Array.from(neighbours);
  }

  isOrphan(file: TFile): boolean {
    const outLinks = this.wikilinkGraph.get(file.path) ?? new Set();
    if (outLinks.size > 0) return false;
    // check for any incoming links
    for (const targets of this.wikilinkGraph.values()) {
      if (targets.has(file.path)) return false;
    }
    return true;
  }

  get size(): number {
    return this.indexSize;
  }

  getAllPaths(): string[] {
    return Array.from(this.pathCache.keys());
  }

  async getNote(path: string): Promise<IndexedNote | null> {
    return (await this.cacheManager?.getNote(path)) ?? null;
  }
}
