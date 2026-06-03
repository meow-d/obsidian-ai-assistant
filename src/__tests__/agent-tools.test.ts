import { vi, describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { makeToolHandlers } from "../features/agent/index";
import type { VaultIndex, SearchResult } from "../core/vault-index";

function makeMockFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split("/").pop()?.replace(".md", "") ?? path;
  return f;
}

function makeIndex(overrides: Partial<VaultIndex> = {}): VaultIndex {
  return {
    search: vi.fn().mockResolvedValue([]),
    getOneHopNeighbours: vi.fn().mockReturnValue([]),
    getOutLinks: vi.fn().mockReturnValue(new Set()),
    ...overrides,
  } as unknown as VaultIndex;
}

function makeApp(pathToFile: Record<string, TFile | null> = {}, vaultOverrides: Record<string, unknown> = {}): App {
  return {
    vault: {
      getAbstractFileByPath: (path: string) => pathToFile[path] ?? null,
      cachedRead: vi.fn().mockResolvedValue("note content"),
      modify: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      ...vaultOverrides,
    },
  } as unknown as App;
}

describe("makeToolHandlers — search_vault", () => {
  it("returns 'no notes found' when search returns empty", async () => {
    const tools = makeToolHandlers(makeIndex(), makeApp());
    const result = await tools.search_vault("query");
    expect(result).toContain("No notes found");
  });

  it("formats results as basename + path + preview", async () => {
    const file = makeMockFile("notes/pkm.md");
    const results: SearchResult[] = [{ file: file as never, score: 0.9, preview: "PKM is great" }];
    const index = makeIndex({ search: vi.fn().mockResolvedValue(results) });
    const tools = makeToolHandlers(index, makeApp());

    const result = await tools.search_vault("pkm");
    expect(result).toContain("pkm");
    expect(result).toContain("notes/pkm.md");
    expect(result).toContain("PKM is great");
  });

  it("clamps limit to minimum of 1", async () => {
    const index = makeIndex({ search: vi.fn().mockResolvedValue([]) });
    const tools = makeToolHandlers(index, makeApp());
    await tools.search_vault("q", 0);
    expect(vi.mocked(index.search)).toHaveBeenCalledWith("q", 1);
  });

  it("clamps limit to maximum of 10", async () => {
    const index = makeIndex({ search: vi.fn().mockResolvedValue([]) });
    const tools = makeToolHandlers(index, makeApp());
    await tools.search_vault("q", 99);
    expect(vi.mocked(index.search)).toHaveBeenCalledWith("q", 10);
  });

  it("defaults limit to 5 when not provided", async () => {
    const index = makeIndex({ search: vi.fn().mockResolvedValue([]) });
    const tools = makeToolHandlers(index, makeApp());
    await tools.search_vault("q");
    expect(vi.mocked(index.search)).toHaveBeenCalledWith("q", 5);
  });
});

describe("makeToolHandlers — read_note", () => {
  it("returns 'not found' message when path does not exist in vault", async () => {
    const tools = makeToolHandlers(makeIndex(), makeApp());
    const result = await tools.read_note("missing.md");
    expect(result).toContain("Note not found");
    expect(result).toContain("missing.md");
  });

  it("returns file content with heading when file exists", async () => {
    const file = makeMockFile("notes/my-note.md");
    const app = makeApp({ "notes/my-note.md": file });
    (app.vault.cachedRead as ReturnType<typeof vi.fn>).mockResolvedValue("Some content.");

    const tools = makeToolHandlers(makeIndex(), app);
    const result = await tools.read_note("notes/my-note.md");
    expect(result).toContain("my-note");
    expect(result).toContain("Some content.");
  });
});

describe("makeToolHandlers — get_linked_notes", () => {
  it("returns 'no linked notes' when there are no neighbours", async () => {
    const tools = makeToolHandlers(makeIndex(), makeApp());
    const result = await tools.get_linked_notes("notes/isolated.md");
    expect(result).toContain("No linked notes");
  });

  it("lists all neighbour paths", async () => {
    const index = makeIndex({
      getOneHopNeighbours: vi.fn().mockReturnValue(["notes/a.md", "notes/b.md"]),
    });
    const tools = makeToolHandlers(index, makeApp());
    const result = await tools.get_linked_notes("notes/hub.md");
    expect(result).toContain("notes/a.md");
    expect(result).toContain("notes/b.md");
  });

  it("passes the path argument to getOneHopNeighbours", async () => {
    const index = makeIndex({ getOneHopNeighbours: vi.fn().mockReturnValue([]) });
    const tools = makeToolHandlers(index, makeApp());
    await tools.get_linked_notes("notes/hub.md");
    expect(vi.mocked(index.getOneHopNeighbours)).toHaveBeenCalledWith("notes/hub.md");
  });
});

describe("makeToolHandlers — edit_note", () => {
  it("returns 'not found' when path does not exist", async () => {
    const tools = makeToolHandlers(makeIndex(), makeApp());
    const result = await tools.edit_note("missing.md", "new content");
    expect(result).toContain("Note not found");
    expect(result).toContain("missing.md");
  });

  it("calls vault.modify with new content and returns success message", async () => {
    const file = makeMockFile("notes/a.md");
    const app = makeApp({ "notes/a.md": file });
    const tools = makeToolHandlers(makeIndex(), app);
    const result = await tools.edit_note("notes/a.md", "# Updated");
    expect(vi.mocked(app.vault.modify)).toHaveBeenCalledWith(file, "# Updated");
    expect(result).toContain("updated successfully");
    expect(result).toContain("a");
  });
});

describe("makeToolHandlers — create_note", () => {
  it("creates a note and returns success message", async () => {
    const app = makeApp();
    const tools = makeToolHandlers(makeIndex(), app);
    const result = await tools.create_note("notes/new.md", "# New");
    expect(vi.mocked(app.vault.create)).toHaveBeenCalledWith("notes/new.md", "# New");
    expect(result).toContain("notes/new.md");
  });

  it("returns 'already exists' when note is already in vault", async () => {
    const file = makeMockFile("notes/existing.md");
    const app = makeApp({ "notes/existing.md": file });
    const tools = makeToolHandlers(makeIndex(), app);
    const result = await tools.create_note("notes/existing.md", "content");
    expect(result).toContain("already exists");
    expect(vi.mocked(app.vault.create)).not.toHaveBeenCalled();
  });

  it("creates the parent folder when it does not exist", async () => {
    const app = makeApp();
    const tools = makeToolHandlers(makeIndex(), app);
    await tools.create_note("deep/folder/note.md", "body");
    expect(vi.mocked(app.vault.createFolder)).toHaveBeenCalledWith("deep/folder");
  });

  it("does not call createFolder for root-level notes", async () => {
    const app = makeApp();
    const tools = makeToolHandlers(makeIndex(), app);
    await tools.create_note("note.md", "body");
    expect(vi.mocked(app.vault.createFolder)).not.toHaveBeenCalled();
  });

  it("does not call createFolder when parent folder already exists", async () => {
    const app = makeApp({ "notes": {} as unknown as TFile });
    const tools = makeToolHandlers(makeIndex(), app);
    await tools.create_note("notes/new.md", "body");
    expect(vi.mocked(app.vault.createFolder)).not.toHaveBeenCalled();
  });
});

describe("makeToolHandlers — delete_note", () => {
  it("returns 'not found' when path does not exist", async () => {
    const tools = makeToolHandlers(makeIndex(), makeApp());
    const result = await tools.delete_note("missing.md");
    expect(result).toContain("Note not found");
    expect(result).toContain("missing.md");
  });

  it("calls vault.delete and returns success message", async () => {
    const file = makeMockFile("notes/old.md");
    const app = makeApp({ "notes/old.md": file });
    const tools = makeToolHandlers(makeIndex(), app);
    const result = await tools.delete_note("notes/old.md");
    expect(vi.mocked(app.vault.delete)).toHaveBeenCalledWith(file);
    expect(result).toContain("old");
    expect(result).toContain("deleted");
  });
});
