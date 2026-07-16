import { ItemView, Notice, TFile, TFolder, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { cosine } from "../core/embedder";
import type { SearchResult, VaultIndex } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";
import { makeActivatable } from "../ui/a11y";
import { renderIndexingStatus } from "../ui/indexing-status";
import { computeTagSuggestions } from "./tag-suggestions";
import { computeFolderSuggestions } from "./folder-suggestions";
import { analyseSplit, NoteSplitModal, type SplitAnalysis } from "./note-split";

const SPLIT_CHECK_INTERVAL_MS = 2 * 60 * 1000;

export const SIMILAR_NOTES_VIEW = "fyp-similar-notes";

interface ResurfaceResult {
  file: TFile;
  score: number;
  similarity: number;
  daysSince: number;
  preview: string;
}

function resurfaceScore(similarity: number, daysSince: number): number {
  const recency = Math.min(daysSince / 7, 1.0);
  return 0.65 * similarity + 0.35 * recency;
}

export class SimilarNotesView extends ItemView {
  private index: VaultIndex;
  private topK: number;
  private minSimilarity: number;
  private refreshInterval: number | null = null;
  private plugin: FypPlugin;
  private generation = 0;
  private lastPath: string | null = null;
  private splitCache = new Map<string, { result: SplitAnalysis | null; timestamp: number }>();
  private unsubscribeIndexing: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, index: VaultIndex, topK: number, minSimilarity: number, plugin: FypPlugin) {
    super(leaf);
    this.index = index;
    this.topK = topK;
    this.minSimilarity = minSimilarity;
    this.plugin = plugin;
  }

  getViewType(): string { return SIMILAR_NOTES_VIEW; }
  getDisplayText(): string { return "Smart Suggestions"; }
  getIcon(): string { return "files"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    createSidebarSwitcher(container, SIDEBAR_VIEWS.SIMILAR_NOTES, (viewType) => {
      if (viewType !== SIDEBAR_VIEWS.SIMILAR_NOTES) {
        this.leaf.setViewState({ type: viewType, active: true });
      }
    });

    await this.refresh();
    const debouncedRefresh = debounce(() => this.refresh(), 200);
    this.registerInterval(
      // @ts-ignore - window.setInterval returns number in browser context
      this.refreshInterval = window.setInterval(() => this.refresh(), 30_000)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => debouncedRefresh())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => debouncedRefresh())
    );
  }

  async onClose(): Promise<void> {
    if (this.refreshInterval !== null) clearInterval(this.refreshInterval);
    this.unsubscribeIndexing?.();
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    const activeFile = this.app.workspace.getActiveFile();
    const container = this.containerEl.children[1] as HTMLElement;

    const render = (body: () => void) => {
      if (gen !== this.generation) return;
      const switcherEl = container.querySelector(".fyp-sidebar-switcher");
      container.empty();
      if (switcherEl) container.appendChild(switcherEl);
      body();
    };

    this.unsubscribeIndexing?.();
    this.unsubscribeIndexing = null;
    if (this.index.isIndexing) {
      render(() => {
        this.unsubscribeIndexing = renderIndexingStatus(container, this.index, () => this.refresh());
      });
      return;
    }

    if (!activeFile) {
      this.lastPath = null;
      render(() => container.createEl("p", { text: "No note open." }));
      return;
    }

    if (activeFile.path !== this.lastPath) {
      this.lastPath = activeFile.path;
      render(() => container.createEl("p", { cls: "fyp-muted", text: "Loading suggestions…" }));
    }

    const emb = await this.index.getEmbedding(activeFile.path);
    if (!emb) {
      render(() => container.createEl("p", { text: "Note not yet indexed." }));
      return;
    }

    const results = (await this.index.searchByEmbedding(emb, this.topK, activeFile.path)).filter(r => r.score >= this.minSimilarity);
    const tags = await computeTagSuggestions(this.app, this.index, activeFile, 10);
    const folders = await computeFolderSuggestions(this.app, this.index, activeFile);
    const alreadyShown = new Set(results.map(r => r.file.path));
    const resurfaceResults = await this.checkResurfacing(emb, activeFile, alreadyShown);
    const split = await this.checkSplit(activeFile);

    render(() => {
      this.renderSplit(container, activeFile, split);
      this.renderSimilarNotes(container, results);
      this.renderResurfacing(container, resurfaceResults);
      this.renderTagSuggestions(container, tags);
      this.renderFolderSuggestions(container, folders);

      const hasContent = results.length > 0 || tags.length > 0 || folders.length > 0 || resurfaceResults.length > 0;
      if (!hasContent) {
        container.createEl("p", { text: "No suggestions available for this note." });
      }
    });
  }

  private renderSimilarNotes(container: HTMLElement, results: SearchResult[]): void {
    if (results.length == 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Similar notes" });
    const list = container.createEl("div", { cls: "fyp-similar-list" });
    for (const r of results) {
      const item = list.createEl("div", { cls: "fyp-similar-item" });
      item.createEl("span", { cls: "fyp-similar-title", text: r.file.basename });
      makeActivatable(item, () => this.app.workspace.getLeaf(false).openFile(r.file));
      item.createEl("span", { cls: "fyp-similar-score", text: r.score.toFixed(3) });
      item.createEl("p", { cls: "fyp-similar-preview", text: r.preview.slice(0, 120) });
    }
  }

  private async checkSplit(file: TFile): Promise<SplitAnalysis | null> {
    const cached = this.splitCache.get(file.path);
    const stale = !cached || Date.now() - cached.timestamp > SPLIT_CHECK_INTERVAL_MS;

    if (!stale) return cached?.result ?? null;

    const text = await this.app.vault.cachedRead(file);
    const analysis = await analyseSplit(text);
    this.splitCache.set(file.path, { result: analysis, timestamp: Date.now() });
    return analysis;
  }

  private renderSplit(container: HTMLElement, file: TFile, analysis: SplitAnalysis | null): void {
    if (!analysis) return;

    const banner = container.createEl("div", { cls: "fyp-split-banner" });
    banner.createEl("span", { text: `This note may contain ${analysis.clusters.length} distinct topics. ` });
    const btn = banner.createEl("button", { text: "Split with AI", cls: "fyp-split-banner-btn" });
    btn.addEventListener("click", () => {
      new NoteSplitModal(this.app, file, analysis!, this.plugin.settings).open();
    });
  }

  private renderTagSuggestions(container: HTMLElement, tags: Array<{ tag: string; score: number }>): void {
    if (tags.length === 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Tag suggestions" });
    const row = container.createEl("div", { cls: "fyp-chip-row" });
    for (const { tag, score } of tags) {
      const chip = row.createEl("span", { cls: "fyp-chip" });
      setIcon(chip.createSpan({ cls: "fyp-chip-icon" }), "tag");
      chip.createSpan({ text: tag });
      chip.createSpan({ cls: "fyp-chip-score", text: score.toFixed(2) });

      const activate = async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;
        await this.app.fileManager.processFrontMatter(activeFile, (fm) => {
          if (!Array.isArray(fm.tags)) fm.tags = fm.tags ? [fm.tags] : [];
          if (!fm.tags.includes(tag)) fm.tags.push(tag);
        });
        chip.addClass("fyp-chip-added");
        chip.querySelector(".fyp-chip-icon") && setIcon(chip.querySelector(".fyp-chip-icon") as HTMLElement, "check");
        chip.tabIndex = -1;
        chip.removeAttribute("role");
        new Notice(`Added #${tag}`);
      };
      makeActivatable(chip, activate);
    }
  }

  private renderFolderSuggestions(container: HTMLElement, folders: Array<{ folder: TFolder; score: number }>): void {
    if (folders.length === 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Folder suggestions" });
    const row = container.createEl("div", { cls: "fyp-chip-row" });
    for (const { folder, score } of folders) {
      const chip = row.createEl("span", { cls: "fyp-chip" });
      setIcon(chip.createSpan({ cls: "fyp-chip-icon" }), "folder-input");
      chip.createSpan({ text: folder.path });
      chip.createSpan({ cls: "fyp-chip-score", text: score.toFixed(2) });

      makeActivatable(chip, async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;
        const newPath = folder.path + "/" + activeFile.name;
        await this.app.fileManager.renameFile(activeFile, newPath);
        new Notice(`${activeFile.name} moved to ${folder.path}`);
      });
    }
  }

  private async checkResurfacing(activeEmb: number[], activeFile: TFile, alreadyShown: Set<string>): Promise<ResurfaceResult[]> {
    const now = Date.now();
    const resurfaceResults: ResurfaceResult[] = [];

    const allNotes = await this.index.getAllNotes();
    for (const [path, note] of allNotes) {
      if (path === activeFile.path) continue;
      if (alreadyShown.has(path)) continue; // avoid duplicating the Similar notes panel

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const daysSince = (now - file.stat.mtime) / 86_400_000;
      const similarity = cosine(activeEmb, note.embedding);
      const score = resurfaceScore(similarity, daysSince);

      if (score >= 0.5) {
        resurfaceResults.push({ file, score, similarity, daysSince: Math.round(daysSince), preview: note.preview });
      }
    }

    resurfaceResults.sort((a, b) => b.score - a.score);
    return resurfaceResults.slice(0, 3);
  }

  private renderResurfacing(container: HTMLElement, resurfaceResults: ResurfaceResult[]): void {
    if (resurfaceResults.length === 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Try revisiting..." });
    const list = container.createEl("div", { cls: "fyp-resurface-list" });
    for (const r of resurfaceResults) {
      const item = list.createEl("div", { cls: "fyp-resurface-item" });
      item.createEl("span", { cls: "fyp-resurface-title", text: r.file.basename });
      makeActivatable(item, () => this.app.workspace.getLeaf(false).openFile(r.file));
      item.createEl("span", {
        cls: "fyp-similar-score",
        text: `${r.similarity.toFixed(3)}, ${r.daysSince}`,
      });
      item.createEl("p", { cls: "fyp-similar-preview", text: r.preview.slice(0, 120) });
    }
  }
}
