import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../core/embedder", () => ({
  embed: vi.fn().mockResolvedValue([[1, 0]]),
  initEmbedder: vi.fn().mockResolvedValue(undefined),
  cosine: (a: number[], b: number[]): number => {
    const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
    const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    return na && nb ? dot / (na * nb) : 0;
  },
}));

import { TFile } from "obsidian";
import type { App } from "obsidian";
import { VaultIndex, prepareNoteText, prepareNoteChunks, splitIntoChunks, MAX_WORDS } from "../core/vault-index";
import type { IndexedNote, NoteChunk } from "../core/vault-index";
import type { CacheManager } from "../core/cache-manager";

function makeMockFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split("/").pop()?.replace(".md", "") ?? path;
  return f;
}

function makeApp(paths: string[] = []): App {
  const fileMap = Object.fromEntries(paths.map((p) => [p, makeMockFile(p)]));
  return {
    vault: {
      getAbstractFileByPath: (path: string) => fileMap[path] ?? null,
    },
  } as unknown as App;
}

interface StoredNote {
  mtime: number;
  chunks: NoteChunk[];
}

function makeChunks(embedding: number[], preview = "p"): NoteChunk[] {
  return [{ embedding, preview }];
}

// Mirror of CacheManager.meanPool: single-chunk notes are returned unchanged,
// multi-chunk notes get the L2-normalised mean.
function meanPool(embs: number[][]): number[] {
  if (embs.length === 1) return embs[0];
  const dim = embs[0]?.length ?? 0;
  const c = new Array(dim).fill(0);
  for (const e of embs) for (let d = 0; d < dim; d++) c[d] += e[d];
  let norm = 0;
  for (let d = 0; d < dim; d++) { c[d] /= embs.length; norm += c[d] * c[d]; }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) c[d] /= norm;
  return c;
}

function toIndexedNote(path: string, stored: StoredNote): IndexedNote {
  return {
    path,
    mtime: stored.mtime,
    embedding: meanPool(stored.chunks.map((c) => c.embedding)),
    preview: stored.chunks[0]?.preview ?? "",
  };
}

class MockCacheManager implements Partial<CacheManager> {
  private notes: Map<string, StoredNote> = new Map();

  async load(): Promise<Map<string, IndexedNote> | null> {
    if (this.notes.size === 0) return null;
    return new Map(Array.from(this.notes, ([p, s]) => [p, toIndexedNote(p, s)]));
  }

  async getNote(path: string): Promise<IndexedNote | null> {
    const stored = this.notes.get(path);
    return stored ? toIndexedNote(path, stored) : null;
  }

  async updateNote(path: string, mtime: number, chunks: NoteChunk[]): Promise<void> {
    this.notes.set(path, { mtime, chunks });
  }

  async removeNote(path: string): Promise<void> {
    this.notes.delete(path);
  }

  async getNoteCount(): Promise<number> {
    return this.notes.size;
  }

  async queryByEmbedding(
    embedding: number[],
    k: number,
    excludePath?: string
  ): Promise<Array<{ path: string; score: number; preview: string }>> {
    const { cosine } = await import("../core/embedder");
    // Keep the best-scoring chunk per note, matching the real cache manager.
    const results: Array<{ path: string; score: number; preview: string }> = [];
    for (const [path, stored] of this.notes) {
      if (path === excludePath) continue;
      let best = -Infinity;
      let preview = "";
      for (const chunk of stored.chunks) {
        const score = cosine(embedding, chunk.embedding);
        if (score > best) { best = score; preview = chunk.preview; }
      }
      results.push({ path, score: best, preview });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  async clear(): Promise<void> {
    this.notes.clear();
  }

  async getAllNotes(): Promise<Map<string, IndexedNote>> {
    return new Map(Array.from(this.notes, ([p, s]) => [p, toIndexedNote(p, s)]));
  }
}

function makeIndex(app?: App, cacheManager?: CacheManager): VaultIndex {
  return new VaultIndex(app ?? makeApp(), "", cacheManager as any);
}

// prepareNoteText
// These tests verify parity with the Python pipeline's clean_frontmatter +
// resolve_wikilinks steps (preprocessing/preprocessor/frontmatter.py and
// preprocessing/preprocessor/wikilinks.py).

describe("prepareNoteText — frontmatter handling", () => {
  it("passes body through unchanged when no frontmatter", () => {
    const text = "# My Note\n\nSome content.";
    expect(prepareNoteText(text)).toBe(text);
  });

  it("strips original frontmatter and replaces with title+tags block", () => {
    const raw = "---\ntitle: Old Title\nauthor: Alice\ntags: [foo, bar]\n---\nBody text.";
    const result = prepareNoteText(raw, "My Note", ["foo", "bar"]);
    expect(result).toContain("title: My Note");
    expect(result).toContain("- foo");
    expect(result).toContain("- bar");
    expect(result).not.toContain("author: Alice");
    expect(result).not.toContain("Old Title");
    expect(result).toContain("Body text.");
  });

  it("drops unknown frontmatter keys (mirrors Python KEEP_KEYS: tags, aliases)", () => {
    const raw = "---\nauthor: Bob\ndate: 2024-01-01\ncreated: 2024\n---\nContent.";
    const result = prepareNoteText(raw, "Note", [], []);
    expect(result).not.toContain("author");
    expect(result).not.toContain("date");
    expect(result).not.toContain("created");
    expect(result).toContain("title: Note");
  });

  it("includes aliases in rebuilt frontmatter", () => {
    const raw = "---\naliases: [A, B]\n---\nContent.";
    const result = prepareNoteText(raw, "Note", [], ["A", "B"]);
    expect(result).toContain("aliases:");
    expect(result).toContain("- A");
    expect(result).toContain("- B");
  });

  it("produces no frontmatter block when no title/tags/aliases given", () => {
    const raw = "---\nauthor: Bob\n---\nContent.";
    const result = prepareNoteText(raw);
    expect(result.startsWith("---")).toBe(false);
    expect(result.trim()).toBe("Content.");
  });

  it("preserves H1 heading (Python does not strip titles)", () => {
    const raw = "---\ntags: [x]\n---\n# My Title\n\nBody.";
    const result = prepareNoteText(raw, "My Title", ["x"]);
    expect(result).toContain("# My Title");
  });

  it("handles missing frontmatter and still injects title block", () => {
    const raw = "# Note\n\nNo frontmatter here.";
    const result = prepareNoteText(raw, "Note");
    expect(result).toContain("title: Note");
    expect(result).toContain("# Note");
    expect(result).toContain("No frontmatter here.");
  });

  it("handles CRLF line endings in frontmatter", () => {
    const raw = "---\r\ntags: [x]\r\n---\r\nBody.";
    const result = prepareNoteText(raw, "Note", ["x"]);
    expect(result).toContain("title: Note");
    expect(result).toContain("Body.");
  });
});

describe("prepareNoteText — wikilink normalisation", () => {
  it("replaces [[target]] with display text", () => {
    const result = prepareNoteText("See [[Node.js]] for details.");
    expect(result).toContain("Node.js");
    expect(result).not.toContain("[[");
  });

  it("uses alias when [[target|alias]] is present", () => {
    const result = prepareNoteText("See [[nodejs|Node]] for details.");
    expect(result).toContain("Node");
    expect(result).not.toContain("nodejs");
    expect(result).not.toContain("[[");
  });

  it("strips heading anchor from [[note#heading]]", () => {
    const result = prepareNoteText("See [[Config#Setup]].");
    expect(result).toContain("Config");
    expect(result).not.toContain("#Setup");
    expect(result).not.toContain("[[");
  });

  it("with resolver: keeps display text for resolved links", () => {
    const resolver = (t: string) => t === "Node.js" ? "notes/Node.js.md" : null;
    const result = prepareNoteText("See [[Node.js]].", undefined, [], [], resolver);
    expect(result).toContain("Node.js");
    expect(result).not.toContain("[[");
  });

  it("with resolver: drops broken links entirely (mirrors Python resolve_wikilinks)", () => {
    const resolver = (_t: string) => null; // all broken
    const result = prepareNoteText("See [[BrokenLink]] for info.", undefined, [], [], resolver);
    expect(result).not.toContain("BrokenLink");
    expect(result).not.toContain("[[");
    expect(result).toContain("for info.");
  });

  it("without resolver: keeps display text for all links (no resolution available)", () => {
    const result = prepareNoteText("See [[BrokenLink]] for info.");
    expect(result).toContain("BrokenLink");
    expect(result).not.toContain("[[");
  });

  it("handles multiple wikilinks in one note", () => {
    // Python: broken links → "", resolved links → display label (even if aliased)
    const resolver = (t: string) => (t === "A" || t === "C") ? `${t}.md` : null;
    const result = prepareNoteText("[[A]] and [[B]] and [[C|alias]].", undefined, [], [], resolver);
    expect(result).toContain("A");       // resolved, no alias → target as display
    expect(result).not.toContain("B");   // broken, dropped
    expect(result).toContain("alias");   // resolved, alias used as display
    expect(result).not.toContain("[[");
  });
});

// prepareNoteChunks / splitIntoChunks
// These verify parity with the Python pipeline's chunking (_split_sections and
// the MAX_WORDS threshold in preprocessing/preprocessor/pipeline.py).

describe("splitIntoChunks — chunking", () => {
  const longSection = (heading: string) => `${heading}\n${"word ".repeat(200)}`;

  it("keeps short notes as a single chunk", () => {
    const prepared = "---\ntitle: N\n---\n# N\n\nShort body.";
    expect(splitIntoChunks(prepared, "---\ntitle: N\n---\n")).toEqual([prepared]);
  });

  it("does not chunk a long note that has no ## / ### headings", () => {
    const prepared = "---\ntitle: N\n---\n" + "word ".repeat(MAX_WORDS + 50);
    const chunks = splitIntoChunks(prepared, "---\ntitle: N\n---\n");
    expect(chunks).toHaveLength(1);
  });

  it("splits a long note before ## / ### headings", () => {
    const fmBlock = "---\ntitle: N\n---\n";
    const prepared = fmBlock + "Intro.\n" + longSection("## A") + "\n" + longSection("### B");
    const chunks = splitIntoChunks(prepared, fmBlock);
    expect(chunks.length).toBe(3); // intro + ## A + ### B
    expect(chunks[1].startsWith("## A")).toBe(false); // fmBlock prepended
    expect(chunks[1].startsWith(fmBlock)).toBe(true);
    expect(chunks[2].startsWith(fmBlock)).toBe(true);
  });

  it("keeps the leading chunk's frontmatter without duplicating it", () => {
    const fmBlock = "---\ntitle: N\n---\n";
    const prepared = fmBlock + "Intro.\n" + longSection("## A");
    const chunks = splitIntoChunks(prepared, fmBlock);
    // The first chunk already starts with the frontmatter, so it is left as-is.
    expect(chunks[0].startsWith(fmBlock)).toBe(true);
    expect(chunks[0].indexOf("---", fmBlock.length)).toBe(-1);
  });

  it("every chunk carries the title/metadata when a note is split", () => {
    const fmBlock = "---\ntitle: N\ntags:\n  - x\n---\n";
    const prepared = fmBlock + longSection("## A") + "\n" + longSection("## B");
    const chunks = splitIntoChunks(prepared, fmBlock);
    for (const c of chunks) expect(c).toContain("title: N");
  });
});

describe("prepareNoteChunks — end to end", () => {
  it("returns one chunk for a short note", () => {
    const chunks = prepareNoteChunks("# Note\n\nBody.", "Note");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("title: Note");
  });

  it("normalises wikilinks within each chunk", () => {
    const body = "Intro [[Foo]].\n" + "## A\n" + "word ".repeat(MAX_WORDS) + " [[Bar|baz]]";
    const chunks = prepareNoteChunks(body, "Note");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).not.toContain("[[");
    expect(chunks.join("\n")).toContain("baz");
  });
});

// VaultIndex — data methods

describe("VaultIndex — data methods", () => {
  it("starts empty", () => {
    const index = makeIndex();
    expect(index.size).toBe(0);
    expect(index.getAllPaths()).toEqual([]);
  });

  it("stores and retrieves notes", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    await (cache as any).updateNote("a.md", 1000, makeChunks([1, 0]));
    const retrieved = await index.getNote("a.md");
    expect(retrieved?.mtime).toBe(1000);
    expect(retrieved?.embedding).toEqual([1, 0]);
  });

  it("getNote returns null for unknown path", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    const note = await index.getNote("missing.md");
    expect(note).toBeNull();
  });

  it("getEmbedding returns the stored embedding", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    await (cache as any).updateNote("a.md", 1000, makeChunks([0.5, 0.5]));
    const emb = await index.getEmbedding("a.md");
    expect(emb).toEqual([0.5, 0.5]);
  });

  it("getEmbedding returns undefined for missing path", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    const emb = await index.getEmbedding("missing.md");
    expect(emb).toBeUndefined();
  });

  it("getMtime returns stored mtime", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    await (cache as any).updateNote("a.md", 9999, makeChunks([]));
    const mtime = await index.getMtime("a.md");
    expect(mtime).toBe(9999);
  });

  it("getMtime returns 0 for missing path", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    const mtime = await index.getMtime("missing.md");
    expect(mtime).toBe(0);
  });
});

describe("VaultIndex — graph methods", () => {
  let index: VaultIndex;

  beforeEach(() => {
    index = makeIndex();
    // graph: a → b, a → c, b → c, d has no edges
    (index as unknown as { wikilinkGraph: Map<string, Set<string>> }).wikilinkGraph = new Map([
      ["a.md", new Set(["b.md", "c.md"])],
      ["b.md", new Set(["c.md"])],
      ["c.md", new Set()],
      ["d.md", new Set()],
    ]);
  });

  it("getOutLinks returns outgoing links", () => {
    expect(index.getOutLinks("a.md")).toEqual(new Set(["b.md", "c.md"]));
  });

  it("getOutLinks returns empty set for isolated node", () => {
    expect(index.getOutLinks("d.md").size).toBe(0);
  });

  it("getOutLinks returns empty set for unknown path", () => {
    expect(index.getOutLinks("unknown.md").size).toBe(0);
  });

  it("getOneHopNeighbours includes outbound links", () => {
    const n = index.getOneHopNeighbours("a.md");
    expect(n).toContain("b.md");
    expect(n).toContain("c.md");
  });

  it("getOneHopNeighbours includes inbound links (reverse edges)", () => {
    const n = index.getOneHopNeighbours("b.md");
    expect(n).toContain("a.md");
  });

  it("getOneHopNeighbours does not include self", () => {
    expect(index.getOneHopNeighbours("a.md")).not.toContain("a.md");
  });

  it("getOneHopNeighbours deduplicates (c.md linked from both a and b)", () => {
    const n = index.getOneHopNeighbours("c.md");
    const countA = n.filter((p) => p === "a.md").length;
    expect(countA).toBe(1);
  });

  it("isOrphan returns true when no links in or out", () => {
    expect(index.isOrphan(makeMockFile("d.md") as never)).toBe(true);
  });

  it("isOrphan returns false when note has outbound links", () => {
    expect(index.isOrphan(makeMockFile("a.md") as never)).toBe(false);
  });

  it("isOrphan returns false when note has inbound links only", () => {
    expect(index.isOrphan(makeMockFile("c.md") as never)).toBe(false);
  });
});

describe("VaultIndex — searchByEmbedding", () => {
  it("returns results sorted by cosine similarity descending", async () => {
    const paths = ["a.md", "b.md", "c.md"];
    const cache = new MockCacheManager();
    const index = makeIndex(makeApp(paths), cache as any);

    await (cache as any).updateNote("a.md", 1000, makeChunks([1, 0]));
    await (cache as any).updateNote("b.md", 1000, makeChunks([0.5, 0.5]));
    await (cache as any).updateNote("c.md", 1000, makeChunks([0, 1]));

    const results = await index.searchByEmbedding([1, 0], 3);
    expect(results[0].file.path).toBe("a.md");
    expect(results[1].file.path).toBe("b.md");
    expect(results[2].file.path).toBe("c.md");
  });

  it("respects k limit", async () => {
    const paths = ["a.md", "b.md", "c.md"];
    const cache = new MockCacheManager();
    const index = makeIndex(makeApp(paths), cache as any);

    await (cache as any).updateNote("a.md", 1000, makeChunks([1, 0]));
    await (cache as any).updateNote("b.md", 1000, makeChunks([0, 1]));
    await (cache as any).updateNote("c.md", 1000, makeChunks([0.5, 0.5]));

    const results = await index.searchByEmbedding([1, 0], 2);
    expect(results).toHaveLength(2);
  });

  it("excludes the excludePath", async () => {
    const paths = ["a.md", "b.md"];
    const cache = new MockCacheManager();
    const index = makeIndex(makeApp(paths), cache as any);

    await (cache as any).updateNote("a.md", 1000, makeChunks([1, 0]));
    await (cache as any).updateNote("b.md", 1000, makeChunks([1, 0]));

    const results = await index.searchByEmbedding([1, 0], 10, "a.md");
    expect(results.map((r) => r.file.path)).not.toContain("a.md");
  });

  it("skips paths where vault returns null (not a TFile)", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(makeApp(["a.md"]), cache as any);

    await (cache as any).updateNote("a.md", 1000, makeChunks([1, 0]));
    await (cache as any).updateNote("b.md", 1000, makeChunks([0, 1]));

    const paths = (await index.searchByEmbedding([1, 0], 10)).map((r) => r.file.path);
    expect(paths).toContain("a.md");
    expect(paths).not.toContain("b.md");
  });

  it("returns empty array when index is empty", async () => {
    const cache = new MockCacheManager();
    const index = makeIndex(undefined, cache as any);
    const results = await index.searchByEmbedding([1, 0], 5);
    expect(results).toEqual([]);
  });
});
