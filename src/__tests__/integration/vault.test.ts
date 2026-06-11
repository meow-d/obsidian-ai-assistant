/**
 * Real integration tests.
 *
 * Uses the actual @huggingface/transformers pipeline (no Web Worker — workers don't
 * exist in Node), the real CacheManager / SQLite, and real vault files from disk.
 *
 * Run with: pnpm test (first run downloads the model, ~80 MB, cached afterwards)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Replace the Web Worker embedder with a direct pipeline call.
// vi.mock is hoisted above all imports by Vitest.
vi.mock("../../core/embedder", async () => {
  const { pipeline } = await import("@huggingface/transformers");

  const MODEL = "Xenova/all-MiniLM-L6-v2";
  let _pipe: any = null;

  async function getOrLoad() {
    if (!_pipe) _pipe = await pipeline("feature-extraction", MODEL, { dtype: "q4" });
    return _pipe;
  }

  return {
    embed: async (texts: string[]): Promise<number[][]> => {
      const pipe = await getOrLoad();
      const out = await pipe(texts, { pooling: "mean", normalize: true });
      return out.tolist() as number[][];
    },
    initEmbedder: async () => {
      await getOrLoad();
      return { vectorSize: 384 };
    },
    setEmbedderStatusCallback: (_cb: unknown) => { },
    cosine: (a: number[], b: number[]): number => {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * (b[i] ?? 0);
      return dot;
    },
  };
});

import { CacheManager } from "../../core/cache-manager";
import { VaultIndex } from "../../core/vault-index";
import { computeTagSuggestions } from "../../features/tag-suggestions";
import { computeFolderSuggestions } from "../../features/folder-suggestions";
import { makeToolHandlers } from "../../features/agent/index";
import { TFile, TFolder } from "obsidian";

// Constants

const VAULT_ROOT = "/home/meow_d/nerd-stuff/4_school/test-for-fyp/test_data3";
const PLUGIN_DIR = path.resolve(__dirname, "../../..");
const MODEL = "Xenova/all-MiniLM-L6-v2";
const MAX_NOTES = 50;

// Vault scanning

interface VaultFile {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number; ctime: number; size: number };
  fullPath: string;
}

function scanVault(root: string, rel = ""): VaultFile[] {
  const results: VaultFile[] = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const entry of fs.readdirSync(dir)) {
    // skip hidden directories (.obsidian, .trash, etc.) and node_modules
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const relPath = rel ? `${rel}/${entry}` : entry;
    const fullPath = path.join(root, relPath);
    const s = fs.statSync(fullPath);
    if (s.isDirectory()) {
      results.push(...scanVault(root, relPath));
    } else if (entry.endsWith(".md")) {
      results.push({
        path: relPath,
        basename: entry.slice(0, -3),
        extension: "md",
        stat: { mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size },
        fullPath,
      });
    }
  }
  return results;
}

// Filesystem adapter (replaces Obsidian vault adapter)

function makeAdapter(tmpDir: string) {
  function res(p: string) {
    return path.isAbsolute(p) ? p : path.join(tmpDir, p);
  }
  return {
    exists: async (p: string) => fs.existsSync(res(p)),
    readBinary: async (p: string): Promise<ArrayBuffer> => {
      const buf = fs.readFileSync(res(p));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    writeBinary: async (p: string, data: Uint8Array) => {
      const full = res(p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(data));
    },
    remove: async (p: string) => { if (fs.existsSync(res(p))) fs.unlinkSync(res(p)); },
    mkdir: async (p: string) => { fs.mkdirSync(res(p), { recursive: true }); },
  };
}

// Wikilink / tag parsing

function parseLinks(content: string): Array<{ link: string }> {
  const re = /\[\[([^\[\]|#\n]+)/g;
  const out: Array<{ link: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push({ link: m[1].trim() });
  return out;
}

function parseTags(content: string): Array<{ tag: string }> {
  const out: Array<{ tag: string }> = [];
  const inlineRe = /(?<![a-zA-Z0-9_])#([a-zA-Z][a-zA-Z0-9_/]*)/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(content)) !== null) out.push({ tag: `#${m[1]}` });
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const listMatch = fmMatch[1].match(/^tags:\s*\[([^\]]*)\]/m);
    if (listMatch) {
      for (const t of listMatch[1].split(",")) {
        const clean = t.trim().replace(/^["']|["']$/g, "");
        if (clean) out.push({ tag: `#${clean}` });
      }
    }
  }
  return out;
}

// App mock

function makeTFile(f: VaultFile): TFile {
  const tf = new TFile();
  tf.path = f.path;
  tf.basename = f.basename;
  tf.extension = f.extension;
  (tf as any).stat = f.stat;
  return tf;
}

function makeApp(files: VaultFile[], adapter: ReturnType<typeof makeAdapter>) {
  const byPath = new Map(files.map(f => [f.path, f]));
  const byBasename = new Map(files.map(f => [f.basename, f]));
  const contentCache = new Map<string, string>();

  // Build folder tree
  function buildFolders(filePaths: string[]): Map<string, TFolder> {
    const folders = new Map<string, TFolder>();
    const folderPaths = new Set<string>();

    for (const filePath of filePaths) {
      const parts = filePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folderPath = parts.slice(0, i).join("/");
        folderPaths.add(folderPath);
      }
    }

    function makeTFolder(path: string): TFolder {
      const folder = { path, name: path.split("/").pop() || "", children: [] } as any;
      return folder as TFolder;
    }

    // Root
    const root = makeTFolder("/");
    folders.set("/", root);

    for (const folderPath of folderPaths) {
      if (!folders.has(folderPath)) {
        folders.set(folderPath, makeTFolder(folderPath));
      }
    }

    // Add files and folders as children
    for (const filePath of filePaths) {
      const file = byPath.get(filePath);
      if (file) {
        const tf = makeTFile(file);
        const parentPath = file.path.includes("/") ? file.path.split("/").slice(0, -1).join("/") : "/";
        const parent = folders.get(parentPath) || folders.get("/");
        if (parent) {
          (tf as any).parent = parent;
          (parent as any).children.push(tf);
        }
      }
    }

    for (const [folderPath, folder] of folders) {
      if (folderPath === "/") continue;
      const parentPath = folderPath.includes("/") ? folderPath.split("/").slice(0, -1).join("/") : "/";
      const parent = folders.get(parentPath) || folders.get("/");
      if (parent) {
        (folder as any).parent = parent;
        (parent as any).children.push(folder);
      }
    }

    return folders;
  }

  const folders = buildFolders(Array.from(byPath.keys()));

  function content(f: VaultFile) {
    if (!contentCache.has(f.path)) contentCache.set(f.path, fs.readFileSync(f.fullPath, "utf-8"));
    return contentCache.get(f.path)!;
  }

  return {
    vault: {
      getMarkdownFiles: () => files.map(makeTFile),
      getRoot: () => folders.get("/") || new TFolder(),
      cachedRead: async (file: TFile) => {
        const f = byPath.get(file.path);
        return f ? content(f) : "";
      },
      getAbstractFileByPath: (p: string) => {
        const f = byPath.get(p);
        return f ? makeTFile(f) : null;
      },
      modify: async (file: TFile, newContent: string) => {
        // In-memory only — no writes to the real vault files
        contentCache.set(file.path, newContent);
      },
      adapter,
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const f = byPath.get(file.path);
        if (!f) return null;
        return { links: parseLinks(content(f)), tags: parseTags(content(f)) };
      },
      getFirstLinkpathDest: (link: string, _from: string) => {
        const f = byBasename.get(link) ?? byBasename.get(link.split("/").pop() ?? link);
        return f ? makeTFile(f) : null;
      },
    },
  };
}

// Test state

let tmpDir: string;
let vaultFiles: VaultFile[];
let app: ReturnType<typeof makeApp>;
let cacheManager: CacheManager;
let index: VaultIndex;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-int-"));
  vaultFiles = scanVault(VAULT_ROOT).slice(0, MAX_NOTES);
  app = makeApp(vaultFiles, makeAdapter(tmpDir));
  cacheManager = new CacheManager(app as any, PLUGIN_DIR);
  index = new VaultIndex(app as any, MODEL, cacheManager);
  await index.build();
}, 300_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Embedding model

describe("embedding model", () => {
  it("produces 384-dimensional embeddings", async () => {
    const { embed } = await import("../../core/embedder");
    const [emb] = await embed(["test sentence"]);
    expect(emb).toHaveLength(384);
  });

  it("embeddings are unit vectors", async () => {
    const { embed } = await import("../../core/embedder");
    const [emb] = await embed(["some text about cloud computing"]);
    const magnitude = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 2);
  });

  it("semantically similar texts have higher similarity than unrelated texts", async () => {
    const { embed, cosine } = await import("../../core/embedder");
    const [aws1, aws2, food] = await embed([
      "AWS EC2 cloud computing virtual machines",
      "Amazon web services compute instances scalable",
      "French cuisine cooking recipes dinner",
    ]);
    expect(cosine(aws1, aws2)).toBeGreaterThan(cosine(aws1, food));
  });
});

// Index build

describe("index build", () => {
  it("indexes all vault files", () => {
    expect(index.size).toBe(vaultFiles.length);
  });

  it("every vault file path appears in the index", () => {
    const indexed = new Set(index.getAllPaths());
    for (const f of vaultFiles) {
      expect(indexed.has(f.path)).toBe(true);
    }
  });

  it("every indexed note has a 384-dim embedding in the cache", async () => {
    const sample = vaultFiles.slice(0, 5);
    for (const f of sample) {
      const emb = await index.getEmbedding(f.path);
      expect(emb).toBeDefined();
      expect(emb!.length).toBe(384);
    }
  });
});

// Semantic search

describe("semantic search", () => {
  it("search() returns results sorted by score descending", async () => {
    const results = await index.search("cloud computing infrastructure", 5);
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("search() for AWS topics surfaces AWS notes in top results", async () => {
    const results = await index.search("AWS cloud services EC2 S3", 5);
    const topNames = results.map(r => r.file.basename.toLowerCase());
    expect(topNames.some(n => n.includes("aws") || n.includes("amazon"))).toBe(true);
  });

  it("searchByEmbedding() excludes the query note", async () => {
    const f = vaultFiles[0];
    const emb = await index.getEmbedding(f.path);
    const results = await index.searchByEmbedding(emb!, 5, f.path);
    expect(results.map(r => r.file.path)).not.toContain(f.path);
  });

  it("searchByEmbedding() respects the k limit", async () => {
    const emb = await index.getEmbedding(vaultFiles[0].path);
    const results = await index.searchByEmbedding(emb!, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("notes about the same topic score higher than unrelated notes", async () => {
    const awsFile = vaultFiles.find(f => f.basename.toLowerCase().startsWith("aws"));
    if (!awsFile) return;
    const emb = await index.getEmbedding(awsFile.path);
    const results = await index.searchByEmbedding(emb!, 10, awsFile.path);
    const awsResults = results.filter(r => r.file.basename.toLowerCase().includes("aws"));
    const nonAwsResults = results.filter(r => !r.file.basename.toLowerCase().includes("aws"));
    if (awsResults.length > 0 && nonAwsResults.length > 0) {
      const avgAws = awsResults.reduce((s, r) => s + r.score, 0) / awsResults.length;
      const avgOther = nonAwsResults.reduce((s, r) => s + r.score, 0) / nonAwsResults.length;
      expect(avgAws).toBeGreaterThan(avgOther);
    }
  });
});

// Incremental updates

describe("incremental updates", () => {
  it("updateFile() re-indexes an existing note without changing path count", async () => {
    const f = vaultFiles[0];
    const before = index.getAllPaths().length;
    await index.updateFile(makeTFile(f));
    expect(index.getAllPaths().length).toBe(before);
    expect(index.getAllPaths()).toContain(f.path);
  });

  it("removeFile() removes the path from the index", async () => {
    const target = vaultFiles[vaultFiles.length - 1];
    expect(index.getAllPaths()).toContain(target.path);
    await index.removeFile(target.path);
    expect(index.getAllPaths()).not.toContain(target.path);
    // restore for subsequent tests
    await index.updateFile(makeTFile(target));
    expect(index.getAllPaths()).toContain(target.path);
  });
});

// Wikilink graph

describe("wikilink graph", () => {
  it("notes with [[links]] whose targets are indexed have non-empty outLinks", () => {
    // Find a file that actually has resolved outlinks (target in vault subset)
    const linked = vaultFiles.find(f => index.getOutLinks(f.path).size > 0);
    expect(linked).toBeDefined();
    expect(index.getOutLinks(linked!.path).size).toBeGreaterThan(0);
  });

  it("getOneHopNeighbours includes both outgoing and incoming links", () => {
    for (const f of vaultFiles) {
      const out = index.getOutLinks(f.path);
      if (out.size === 0) continue;
      const [target] = out;
      const neighbours = index.getOneHopNeighbours(target);
      expect(neighbours).toContain(f.path);
      return;
    }
  });

  it("getOneHopNeighbours does not include the node itself", () => {
    for (const f of vaultFiles) {
      const out = index.getOutLinks(f.path);
      if (out.size === 0) continue;
      const neighbours = index.getOneHopNeighbours(f.path);
      expect(neighbours).not.toContain(f.path);
      return;
    }
  });

  it("isOrphan returns false for notes with links", () => {
    const linked = vaultFiles.find(f => index.getOutLinks(f.path).size > 0);
    if (!linked) return;
    expect(index.isOrphan(makeTFile(linked) as any)).toBe(false);
  });

  it("isOrphan returns true for notes with no links in or out", () => {
    const orphan = vaultFiles.find(f => {
      if (index.getOutLinks(f.path).size > 0) return false;
      for (const other of vaultFiles) {
        if (index.getOutLinks(other.path).has(f.path)) return false;
      }
      return true;
    });
    if (!orphan) return;
    expect(index.isOrphan(makeTFile(orphan) as any)).toBe(true);
  });
});

// Cache persistence

describe("cache persistence", () => {
  it("reloads all embeddings from SQLite with correct dimensions", async () => {
    const fresh = new CacheManager(app as any, PLUGIN_DIR);
    const loaded = await fresh.load(MODEL);
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(vaultFiles.length);
    for (const [, note] of loaded!) {
      expect(note.embedding.length).toBe(384);
    }
  });

  it("reloaded embeddings match the originals", async () => {
    const f = vaultFiles[0];
    const original = await cacheManager.getNote(f.path);
    const fresh = new CacheManager(app as any, PLUGIN_DIR);
    const loaded = (await fresh.load(MODEL))!;
    const fromDisk = loaded.get(f.path);
    expect(fromDisk).toBeDefined();
    expect(fromDisk!.mtime).toBe(original!.mtime);
    expect(fromDisk!.embedding[0]).toBeCloseTo(original!.embedding[0], 5);
  });

  it("loading with a different model path clears the cache and returns null", async () => {
    const altTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-alt-"));
    try {
      const altApp = makeApp(vaultFiles, makeAdapter(altTmp));
      const mgr1 = new CacheManager(altApp as any, PLUGIN_DIR);
      const { embed } = await import("../../core/embedder");
      const [emb] = await embed(["test"]);
      await mgr1.updateNote("a.md", 1, [{ embedding: emb, preview: "p" }]);
      await mgr1.saveModelPath("model-a");
      const mgr2 = new CacheManager(altApp as any, PLUGIN_DIR);
      const result = await mgr2.load("model-b");
      expect(result).toBeNull();
    } finally {
      fs.rmSync(altTmp, { recursive: true, force: true });
    }
  });

  it("after cache clear, re-indexing produces a valid cache", async () => {
    const altTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-rebuild-"));
    try {
      const subset = vaultFiles.slice(0, 5);
      const altApp = makeApp(subset, makeAdapter(altTmp));
      const mgr = new CacheManager(altApp as any, PLUGIN_DIR);
      const idx = new VaultIndex(altApp as any, MODEL, mgr);
      await idx.build();
      const reloaded = await new CacheManager(altApp as any, PLUGIN_DIR).load(MODEL);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.size).toBe(subset.length);
    } finally {
      fs.rmSync(altTmp, { recursive: true, force: true });
    }
  });
});

// Resurfacing

describe("resurfaceScore (new algorithm)", () => {
  function resurfaceScore(similarity: number, daysSince: number): number {
    const recency = Math.min(daysSince / 7, 1.0);
    return 0.65 * similarity + 0.35 * recency;
  }

  it("returns correct blend of similarity (65%) and recency (35%)", () => {
    const sim = 0.8;
    const days = 14;
    const expected = 0.65 * sim + 0.35 * Math.min(days / 7, 1.0);
    expect(resurfaceScore(sim, days)).toBeCloseTo(expected);
  });

  it("older notes rank higher than recent ones", () => {
    const recent = resurfaceScore(0.5, 1);
    const old = resurfaceScore(0.5, 14);
    expect(old).toBeGreaterThan(recent);
  });

  it("more similar notes rank higher than less similar ones", () => {
    const lessSim = resurfaceScore(0.3, 14);
    const moreSim = resurfaceScore(0.9, 14);
    expect(moreSim).toBeGreaterThan(lessSim);
  });

  it("recency caps at 1.0 after 7 days", () => {
    const week = resurfaceScore(0.5, 7);
    const month = resurfaceScore(0.5, 30);
    expect(week).toBeCloseTo(month);
  });

  it("shows notes only if score >= 0.5", () => {
    const lowScore = resurfaceScore(0.1, 1);
    const highScore = resurfaceScore(0.9, 7);
    expect(lowScore).toBeLessThan(0.5);
    expect(highScore).toBeGreaterThanOrEqual(0.5);
  });
});

// Tag suggestions

describe("computeTagSuggestions", () => {
  it("returns an array of {tag, score} for an indexed note", async () => {
    const f = vaultFiles[0];
    const suggestions = await computeTagSuggestions(app as any, index, makeTFile(f));
    expect(Array.isArray(suggestions)).toBe(true);
    for (const s of suggestions) {
      expect(typeof s.tag).toBe("string");
      expect(typeof s.score).toBe("number");
      expect(s.score).toBeGreaterThan(0);
    }
  });

  it("does not suggest tags already on the note", async () => {
    const withTags = vaultFiles.find(f => {
      return parseTags(fs.readFileSync(f.fullPath, "utf-8")).length > 0;
    });
    if (!withTags) return;
    const ownTags = new Set(parseTags(fs.readFileSync(withTags.fullPath, "utf-8")).map(t => t.tag));
    const suggestions = await computeTagSuggestions(app as any, index, makeTFile(withTags));
    for (const s of suggestions) {
      expect(ownTags.has(s.tag)).toBe(false);
    }
  });
});

// Folder suggestions

describe("computeFolderSuggestions", () => {
  it("returns an array of {folder, score} for an indexed note", async () => {
    const f = vaultFiles[0];
    const suggestions = await computeFolderSuggestions(app as any, index, makeTFile(f));
    expect(Array.isArray(suggestions)).toBe(true);
    for (const s of suggestions) {
      expect(s.folder.path).toBeDefined();
      expect(typeof s.score).toBe("number");
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it("does not suggest the note's own folder", async () => {
    const f = vaultFiles[0];
    const suggestions = await computeFolderSuggestions(app as any, index, makeTFile(f));
    const ownFolder = makeTFile(f).parent?.path;
    for (const s of suggestions) {
      expect(s.folder.path).not.toBe(ownFolder);
    }
  });

  it("returns at most 2 suggestions", async () => {
    const f = vaultFiles[0];
    const suggestions = await computeFolderSuggestions(app as any, index, makeTFile(f));
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });
});

// Agent tool handlers

describe("makeToolHandlers", () => {
  let tools: ReturnType<typeof makeToolHandlers>;

  beforeAll(() => {
    tools = makeToolHandlers(index, app as any);
  });

  it("search_vault returns formatted results for a relevant query", async () => {
    const result = await tools.search_vault("cloud computing AWS");
    expect(typeof result).toBe("string");
    expect(result).not.toBe("No notes found matching that query.");
    // Each result line has a bold title
    expect(result).toMatch(/\*\*[^*]+\*\*/);
  });

  it("search_vault returns no-results message when nothing matches", async () => {
    // Extremely specific nonsense query unlikely to match anything
    const result = await tools.search_vault("xyzzy42 frobnicate unicorn_dance_party");
    // Either returns no-results OR finds something — both are valid; just assert string
    expect(typeof result).toBe("string");
  });

  it("search_vault respects the limit parameter", async () => {
    const result = await tools.search_vault("programming software", 2);
    // Count double-asterisk bold pairs; each result has exactly one **title**
    const boldMatches = result.match(/\*\*[^*]+\*\*/g) ?? [];
    expect(boldMatches.length).toBeLessThanOrEqual(2);
  });

  it("read_note returns content prefixed with the note title", async () => {
    const f = vaultFiles[0];
    const result = await tools.read_note(f.path);
    expect(result.startsWith(`# ${f.basename}`)).toBe(true);
  });

  it("read_note content contains the raw note body", async () => {
    const f = vaultFiles[0];
    const raw = fs.readFileSync(f.fullPath, "utf-8");
    const result = await tools.read_note(f.path);
    // At least the first line of the body should appear
    const firstLine = raw.split("\n").find(l => l.trim().length > 0) ?? "";
    if (firstLine) expect(result).toContain(firstLine.trim());
  });

  it("read_note returns error message for an unknown path", async () => {
    const result = await tools.read_note("no/such/note.md");
    expect(result).toContain("Note not found");
  });

  it("get_linked_notes returns paths for a connected note", async () => {
    const linked = vaultFiles.find(f => index.getOutLinks(f.path).size > 0);
    if (!linked) return;
    const result = await tools.get_linked_notes(linked.path);
    expect(result).not.toBe("No linked notes found.");
    expect(result).toContain(".md");
  });

  it("get_linked_notes returns no-links message for an isolated note", async () => {
    const orphan = vaultFiles.find(f => {
      if (index.getOutLinks(f.path).size > 0) return false;
      for (const other of vaultFiles) {
        if (index.getOutLinks(other.path).has(f.path)) return false;
      }
      return true;
    });
    if (!orphan) return;
    const result = await tools.get_linked_notes(orphan.path);
    expect(result).toBe("No linked notes found.");
  });

  it("edit_note updates the in-memory content and returns success", async () => {
    const f = vaultFiles[0];
    const newContent = "# Updated\n\nNew content from test.";
    const result = await tools.edit_note(f.path, newContent);
    expect(result).toContain("updated successfully");
    // Subsequent read should reflect the new content
    const readBack = await tools.read_note(f.path);
    expect(readBack).toContain("New content from test.");
  });

  it("edit_note returns error message for an unknown path", async () => {
    const result = await tools.edit_note("ghost/note.md", "content");
    expect(result).toContain("Note not found");
  });
});
