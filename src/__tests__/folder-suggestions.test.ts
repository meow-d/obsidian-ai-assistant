import { vi, describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { computeFolderSuggestions } from "../features/folder-suggestions";
import type { VaultIndex, SearchResult } from "../core/vault-index";

function makeFolder(path: string, mdChildren: string[] = []): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.children = mdChildren.map((name) => {
    const f = new TFile();
    f.path = `${path}/${name}`;
    return f;
  });
  return folder;
}

function makeMockFile(path: string, parentPath = "/"): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split("/").pop()?.replace(".md", "") ?? path;
  f.parent = makeFolder(parentPath) as unknown as TFolder;
  return f;
}

function makeIndex(results: SearchResult[] = [], embedding: number[] | undefined = [1, 0]): VaultIndex {
  return {
    getEmbedding: vi.fn().mockResolvedValue(embedding),
    searchByEmbedding: vi.fn().mockResolvedValue(results),
  } as unknown as VaultIndex;
}

function makeApp(foldersByPath: Record<string, TFolder> = {}): App {
  return {
    vault: {
      getAbstractFileByPath: (path: string) => foldersByPath[path] ?? null,
    },
  } as unknown as App;
}


describe("computeFolderSuggestions", () => {
  it("returns empty array when note has no embedding", async () => {
    const index = makeIndex([], undefined);
    const suggestions = await computeFolderSuggestions(makeApp(), index, makeMockFile("a.md"));
    expect(suggestions).toEqual([]);
  });

  it("returns empty array when there are no neighbours", async () => {
    const index = makeIndex([]);
    const suggestions = await computeFolderSuggestions(makeApp(), index, makeMockFile("a.md"));
    expect(suggestions).toEqual([]);
  });

  it("excludes the current note's own folder from suggestions", async () => {
    const folder = makeFolder("notes", ["a.md", "b.md", "c.md", "d.md"]);
    const activeFile = makeMockFile("notes/a.md", "notes");
    activeFile.parent = folder as unknown as TFolder;

    const result: SearchResult = {
      file: makeMockFile("notes/b.md", "notes") as never,
      score: 0.9,
      preview: "",
    };
    (result.file as any).parent = folder;

    const index = makeIndex([result]);
    const app = makeApp({ notes: folder });
    const suggestions = await computeFolderSuggestions(app, index, activeFile);
    expect(suggestions.map((s) => s.folder.path)).not.toContain("notes");
  });

  it("excludes root-level neighbours (parent.path === '/')", async () => {
    const rootFolder = makeFolder("/", ["root-note.md"]);
    const result: SearchResult = {
      file: makeMockFile("root-note.md", "/") as never,
      score: 0.9,
      preview: "",
    };
    (result.file as any).parent = rootFolder;

    const index = makeIndex([result]);
    const suggestions = await computeFolderSuggestions(makeApp(), index, makeMockFile("a.md"));
    expect(suggestions).toEqual([]);
  });

  it("returns a suggestion when neighbours share a folder", async () => {
    const folder = makeFolder("projects", ["x.md", "y.md", "z.md", "w.md"]);
    const results: SearchResult[] = [
      { file: Object.assign(makeMockFile("projects/x.md"), { parent: folder }) as never, score: 0.8, preview: "" },
      { file: Object.assign(makeMockFile("projects/y.md"), { parent: folder }) as never, score: 0.7, preview: "" },
    ];
    const index = makeIndex(results);
    const app = makeApp({ projects: folder });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/a.md"));
    expect(suggestions.map((s) => s.folder.path)).toContain("projects");
  });

  it("score is weight / sqrt(size), so larger folders need proportionally more votes", async () => {
    const smallFolder = makeFolder("small", ["a.md", "b.md", "c.md", "d.md"]);
    const bigFolder = makeFolder("big", Array.from({ length: 16 }, (_, i) => `n${i}.md`));

    const results: SearchResult[] = [
      { file: Object.assign(makeMockFile("small/a.md"), { parent: smallFolder }) as never, score: 0.6, preview: "" },
      { file: Object.assign(makeMockFile("big/a.md"), { parent: bigFolder }) as never, score: 0.6, preview: "" },
    ];
    const index = makeIndex(results);
    const app = makeApp({ small: smallFolder, big: bigFolder });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));

    const small = suggestions.find((s) => s.folder.path === "small");
    const big = suggestions.find((s) => s.folder.path === "big");

    expect(small?.score).toBeGreaterThan(big?.score ?? 0);
  });

  it("returns at most 2 suggestions", async () => {
    const folders = ["a", "b", "c"].map((name) => makeFolder(name, ["n1.md", "n2.md", "n3.md", "n4.md"]));
    const results: SearchResult[] = folders.map((folder, i) => ({
      file: Object.assign(makeMockFile(`${folder.path}/note.md`), { parent: folder }) as never,
      score: 0.9 - i * 0.05,
      preview: "",
    }));
    const index = makeIndex(results);
    const app = makeApp(Object.fromEntries(folders.map((f) => [f.path, f])));
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  it("sorts suggestions by descending score", async () => {
    const folderA = makeFolder("alpha", ["n1.md", "n2.md", "n3.md", "n4.md"]);
    const folderB = makeFolder("beta", ["n1.md", "n2.md", "n3.md", "n4.md"]);
    const results: SearchResult[] = [
      { file: Object.assign(makeMockFile("alpha/a.md"), { parent: folderA }) as never, score: 0.5, preview: "" },
      { file: Object.assign(makeMockFile("beta/b.md"), { parent: folderB }) as never, score: 0.9, preview: "" },
    ];
    const index = makeIndex(results);
    const app = makeApp({ alpha: folderA, beta: folderB });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions[0].folder.path).toBe("beta");
  });

  it("ignores neighbours below the minimum similarity, even in aggregate", async () => {
    const folder = makeFolder("weak", ["n1.md", "n2.md", "n3.md", "n4.md"]);
    const results: SearchResult[] = Array.from({ length: 5 }, (_, i) => ({
      file: Object.assign(makeMockFile(`weak/a${i}.md`), { parent: folder }) as never,
      score: 0.15, // 5 * 0.15 / sqrt(4) = 0.375, which used to clear the 0.3 floor
      preview: "",
    }));
    const index = makeIndex(results);
    const app = makeApp({ weak: folder });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions).toEqual([]);
  });

  it("filters out suggestions below the minimum score threshold", async () => {
    const folder = makeFolder("big", Array.from({ length: 10000 }, (_, i) => `n${i}.md`));
    const result: SearchResult = {
      file: Object.assign(makeMockFile("big/a.md"), { parent: folder }) as never,
      score: 0.001,
      preview: "",
    };
    const index = makeIndex([result]);
    const app = makeApp({ big: folder });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions).toEqual([]);
  });

  it("filters out weak matches around 0.14-0.17 that used to pass the old 0.1 floor", async () => {
    const folder = makeFolder("weak", ["n1.md", "n2.md", "n3.md", "n4.md"]);
    const result: SearchResult = {
      file: Object.assign(makeMockFile("weak/a.md"), { parent: folder }) as never,
      score: 0.3, // score/sqrt(4) = 0.15
      preview: "",
    };
    const index = makeIndex([result]);
    const app = makeApp({ weak: folder });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions).toEqual([]);
  });

  it("keeps matches at or above the current 0.3 floor", async () => {
    const folder = makeFolder("strong", ["n1.md", "n2.md", "n3.md", "n4.md"]);
    const result: SearchResult = {
      file: Object.assign(makeMockFile("strong/a.md"), { parent: folder }) as never,
      score: 0.6, // score/sqrt(4) = 0.3
      preview: "",
    };
    const index = makeIndex([result]);
    const app = makeApp({ strong: folder });
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions.map((s) => s.folder.path)).toContain("strong");
  });

  it("skips folders that vault cannot resolve", async () => {
    const folder = makeFolder("orphan", ["n1.md", "n2.md", "n3.md", "n4.md"]);
    const result: SearchResult = {
      file: Object.assign(makeMockFile("orphan/a.md"), { parent: folder }) as never,
      score: 0.9,
      preview: "",
    };
    const index = makeIndex([result]);
    const app = makeApp({});
    const suggestions = await computeFolderSuggestions(app, index, makeMockFile("other/note.md"));
    expect(suggestions).toEqual([]);
  });
});
