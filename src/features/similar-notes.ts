import { ItemView, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { cosine } from "../core/embedder";
import type { SearchResult, VaultIndex } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";
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
  private splitCache = new Map<string, { result: SplitAnalysis | null; timestamp: number }>();

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
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEWS.SIMILAR_NOTES);
        this.plugin.activateViewFromSwitcher(viewType);
      }
    });

    await this.refresh();
    this.registerInterval(
      // @ts-ignore - window.setInterval returns number in browser context
      this.refreshInterval = window.setInterval(() => this.refresh(), 30_000)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh())
    );
  }

  async onClose(): Promise<void> {
    if (this.refreshInterval !== null) clearInterval(this.refreshInterval);
  }

  async refresh(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const container = this.containerEl.children[1] as HTMLElement;
    const switcherEl = container.querySelector(".fyp-sidebar-switcher");

    container.empty();
    if (switcherEl) container.appendChild(switcherEl);

    if (!activeFile) {
      container.createEl("p", { text: "No note open." });
      return;
    }

    const emb = await this.index.getEmbedding(activeFile.path);
    if (!emb) {
      container.createEl("p", { text: "Note not yet indexed." });
      return;
    }

    const results = (await this.index.searchByEmbedding(emb, this.topK, activeFile.path)).filter(r => r.score >= this.minSimilarity);
    const tags = await computeTagSuggestions(this.app, this.index, activeFile, 10);
    const folders = await computeFolderSuggestions(this.app, this.index, activeFile);
    const resurfaceResults = await this.checkResurfacing(emb, activeFile);

    await this.checkAndRenderSplit(container, activeFile);
    await this.renderSimilarNotes(container, results)
    await this.renderResurfacing(container, resurfaceResults);
    await this.renderTagSuggestions(container, tags);
    await this.renderFolderSuggestions(container, folders);

    const hasContent = results.length > 0 || tags.length > 0 || folders.length > 0 || resurfaceResults.length > 0;

    if (!hasContent) {
      container.createEl("p", { text: "No suggestions available for this note." });
    }
  }

  private async renderSimilarNotes(container: HTMLElement, results: SearchResult[]): Promise<void> {
    if (results.length == 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Similar notes" });
    const list = container.createEl("div", { cls: "fyp-similar-list" });
    for (const r of results) {
      const item = list.createEl("div", { cls: "fyp-similar-item" });
      const link = item.createEl("a", { cls: "fyp-similar-title", text: r.file.basename });
      link.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(r.file));
      item.createEl("span", { cls: "fyp-similar-score", text: ` (${r.score.toFixed(3)})` });
      item.createEl("p", { cls: "fyp-similar-preview", text: r.preview.slice(0, 120) });
    }
  }

  private async checkAndRenderSplit(container: HTMLElement, file: TFile): Promise<void> {
    const cached = this.splitCache.get(file.path);
    const stale = !cached || Date.now() - cached.timestamp > SPLIT_CHECK_INTERVAL_MS;

    let analysis: SplitAnalysis | null = cached?.result ?? null;

    if (stale) {
      const text = await this.app.vault.cachedRead(file);
      analysis = await analyseSplit(text);
      this.splitCache.set(file.path, { result: analysis, timestamp: Date.now() });
    }

    if (!analysis) return;

    const banner = container.createEl("div", { cls: "fyp-split-banner" });
    banner.createEl("span", { text: `This note may contain ${analysis.clusters.length} distinct topics. ` });
    const btn = banner.createEl("button", { text: "Split with AI", cls: "fyp-split-banner-btn" });
    btn.addEventListener("click", () => {
      new NoteSplitModal(this.app, file, analysis!, this.plugin.settings).open();
    });
  }

  private async renderTagSuggestions(container: HTMLElement, tags: Array<{ tag: string; score: number }>): Promise<void> {
    if (tags.length === 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Tag suggestions" });
    const list = container.createEl("div", { cls: "fyp-similar-list" });
    for (const { tag, score } of tags) {
      const item = list.createEl("div", { cls: "fyp-similar-item" });
      item.createEl("code", { cls: "fyp-similar-title", text: tag });
      item.createEl("span", { cls: "fyp-similar-score", text: ` (${score.toFixed(3)})` });
    }
  }

  private async renderFolderSuggestions(container: HTMLElement, folders: Array<{ folder: TFolder; score: number }>): Promise<void> {
    if (folders.length === 0) return;

    container.createEl("h3", { cls: "fyp-similar-header", text: "Folder suggestions" });
    const list = container.createEl("div", { cls: "fyp-similar-list" });
    for (const { folder, score } of folders) {
      const item = list.createEl("div", { cls: "fyp-similar-item" });
      const link = item.createEl("a", { cls: "fyp-similar-title", text: folder.path });
      link.addEventListener("click", async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;
        const newPath = folder.path + "/" + activeFile.name;
        await this.app.fileManager.renameFile(activeFile, newPath);
        new Notice(`${activeFile.name} moved to ${folder.path}`);
      });
      item.createEl("span", { cls: "fyp-similar-score", text: ` (${score.toFixed(3)})` });
    }
  }

  private async checkResurfacing(activeEmb: number[], activeFile: TFile): Promise<ResurfaceResult[]> {
    const now = Date.now();
    const resurfaceResults: ResurfaceResult[] = [];

    for (const path of this.index.getAllPaths()) {
      if (path === activeFile.path) continue;
      const note = await this.index.getNote(path);
      if (!note) continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const daysSince = (now - file.stat.mtime) / 86_400_000;
      const similarity = cosine(activeEmb, note.embedding);
      const score = resurfaceScore(similarity, daysSince);

      if (score >= 0.5) {
        resurfaceResults.push({ file, score, similarity, daysSince: Math.round(daysSince) });
      }
    }

    resurfaceResults.sort((a, b) => b.score - a.score);
    return resurfaceResults.slice(0, 3);
  }

  private async renderResurfacing(container: HTMLElement, resurfaceResults: ResurfaceResult[]): Promise<void> {
    if (resurfaceResults.length === 0) return;

    container.createEl("h3", { cls: "fyp-header", text: "Try revisiting..." });
    const list = container.createEl("div", { cls: "fyp-resurface-list" });
    for (const r of resurfaceResults) {
      const item = list.createEl("div", { cls: "fyp-resurface-item" });
      const link = item.createEl("a", { cls: "fyp-resurface-title", text: r.file.basename });
      link.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(r.file));
      item.createEl("span", {
        cls: "fyp-similar-score",
        text: `  (${r.similarity.toFixed(3)},  ${r.daysSince}d ago)`,
      });
      const note = await this.index.getNote(r.file.path);
      if (note) item.createEl("p", { cls: "fyp-similar-preview", text: note.preview.slice(0, 120) });
    }
  }
}
