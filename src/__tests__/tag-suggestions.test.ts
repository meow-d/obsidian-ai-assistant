import { vi, describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { computeTagSuggestions } from "../features/tag-suggestions";
import type { VaultIndex, SearchResult } from "../core/vault-index";

function makeMockFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split("/").pop()?.replace(".md", "") ?? path;
  return f;
}

function makeResult(path: string, score: number): SearchResult {
  return { file: makeMockFile(path) as never, score, preview: "" };
}

function makeIndex(results: SearchResult[] = []): VaultIndex {
  return {
    getEmbedding: vi.fn().mockResolvedValue([1, 0]),
    searchByEmbedding: vi.fn().mockResolvedValue(results),
  } as unknown as VaultIndex;
}

function makeApp(tagsByPath: Record<string, string[]> = {}, currentTags: string[] = []): App {
  return {
    metadataCache: {
      getFileCache: (file: TFile) => {
        const raw = file.path in tagsByPath ? tagsByPath[file.path] : currentTags;
        return { tags: raw.map((t) => ({ tag: `#${t}` })) };
      },
    },
  } as unknown as App;
}

describe("computeTagSuggestions", () => {
  it("returns empty array when note has no embedding", async () => {
    const index = { getEmbedding: vi.fn().mockResolvedValue(undefined) } as unknown as VaultIndex;
    const result = await computeTagSuggestions(makeApp(), index, makeMockFile("a.md"));
    expect(result).toEqual([]);
  });

  it("returns empty array when no similar notes have tags", async () => {
    const index = makeIndex([makeResult("b.md", 0.9)]);
    const app = makeApp({ "b.md": [] });
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    expect(suggestions).toEqual([]);
  });

  it("returns tags from similar notes", async () => {
    const index = makeIndex([makeResult("b.md", 0.9)]);
    const app = makeApp({ "b.md": ["pkm"] });
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    expect(suggestions.map((s) => s.tag)).toContain("pkm");
  });

  it("excludes tags already on the current file", async () => {
    const index = makeIndex([makeResult("b.md", 0.9)]);
    const app: App = {
      metadataCache: {
        getFileCache: (file: TFile) => {
          if (file.path === "a.md") return { tags: [{ tag: "#pkm" }] };
          return { tags: [{ tag: "#pkm" }] };
        },
      },
    } as unknown as App;
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    expect(suggestions.map((s) => s.tag)).not.toContain("pkm");
  });

  it("accumulates scores across multiple similar notes mentioning the same tag", async () => {
    const index = makeIndex([makeResult("b.md", 0.8), makeResult("c.md", 0.6)]);
    const app = makeApp({ "b.md": ["pkm"], "c.md": ["pkm"] });
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    const pkm = suggestions.find((s) => s.tag === "pkm");
    expect(pkm?.score).toBeCloseTo(0.8 + 0.6);
  });

  it("sorts suggestions by descending score", async () => {
    const index = makeIndex([makeResult("b.md", 0.5), makeResult("c.md", 0.9), makeResult("d.md", 0.8)]);
    const app = makeApp({ "b.md": ["rare"], "c.md": ["common"], "d.md": ["common"] });
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    expect(suggestions[0].tag).toBe("common");
  });

  it("strips leading # from tag strings", async () => {
    const index = makeIndex([makeResult("b.md", 0.9)]);
    const app = makeApp({ "b.md": ["pkm"] });
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    expect(suggestions[0].tag).toBe("pkm");
    expect(suggestions[0].tag.startsWith("#")).toBe(false);
  });

  it("returns at most 10 suggestions", async () => {
    const results = Array.from({ length: 15 }, (_, i) => makeResult(`note${i}.md`, 0.9 - i * 0.01));
    const index = makeIndex(results);
    const tagsByPath = Object.fromEntries(results.map((r, i) => [r.file.path, [`tag${i}`]]));
    const app = makeApp(tagsByPath);
    const suggestions = await computeTagSuggestions(app, index, makeMockFile("a.md"));
    expect(suggestions.length).toBeLessThanOrEqual(10);
  });

  it("passes topK to searchByEmbedding", async () => {
    const index = makeIndex();
    await computeTagSuggestions(makeApp(), index, makeMockFile("a.md"), 7);
    expect(vi.mocked(index.searchByEmbedding)).toHaveBeenCalledWith(expect.anything(), 7, "a.md");
  });
});
