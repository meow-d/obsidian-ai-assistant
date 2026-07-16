import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { VaultIndex, SearchResult } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";
import { makeActivatable } from "../ui/a11y";
import { renderIndexingStatus } from "../ui/indexing-status";

export const ORPHAN_RESCUER_VIEW = "fyp-orphan-rescuer";

interface OrphanEntry {
  file: TFile;
  suggestions: SearchResult[];
}

export class OrphanRescuerView extends ItemView {
  private index: VaultIndex;
  private topK: number;
  private plugin: FypPlugin;
  private entries: OrphanEntry[] = [];
  private unsubscribeIndexing: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, index: VaultIndex, topK: number, plugin: FypPlugin) {
    super(leaf);
    this.index = index;
    this.topK = topK;
    this.plugin = plugin;
  }

  getViewType(): string { return ORPHAN_RESCUER_VIEW; }
  getDisplayText(): string { return "Orphan rescuer"; }
  getIcon(): string { return "unlink"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    createSidebarSwitcher(container, SIDEBAR_VIEWS.ORPHAN_RESCUER, (viewType) => {
      if (viewType !== SIDEBAR_VIEWS.ORPHAN_RESCUER) {
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEWS.ORPHAN_RESCUER);
        this.plugin.activateViewFromSwitcher(viewType);
      }
    });

    if (this.index.isIndexing) {
      this.unsubscribeIndexing = renderIndexingStatus(container, this.index, () => this.onOpen());
      return;
    }

    const panel = container.createEl("div", { cls: "fyp-indexing-panel" });
    panel.createEl("div", { cls: "fyp-indexing-spinner" });
    const detail = panel.createEl("p", { cls: "fyp-indexing-detail", text: "Scanning vault for orphan notes…" });

    await this.loadOrphans((current, total) => {
      detail.setText(`Scanning orphan notes… (${current}/${total})`);
    });

    panel.remove();
    await this.render(container);
  }

  private async loadOrphans(onProgress: (current: number, total: number) => void): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const orphans = files.filter((f) => this.index.isOrphan(f));

    this.entries = [];
    for (let i = 0; i < orphans.length; i++) {
      const file = orphans[i];
      onProgress(i, orphans.length);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      const emb = await this.index.getEmbedding(file.path);
      if (!emb) continue;
      const suggestions = (await this.index.searchByEmbedding(emb, this.topK, file.path))
        .filter((r) => r.score > 0.5)
        .slice(0, 3);
      this.entries.push({ file, suggestions });
    }
  }

  private async render(container: HTMLElement): Promise<void> {
    const switcherEl = container.querySelector(".fyp-sidebar-switcher");
    container.empty();
    if (switcherEl) container.appendChild(switcherEl);

    if (this.entries.length === 0) {
      container.createEl("p", { text: "No orphan notes found.", cls: "fyp-muted" });
      return;
    }

    container.createEl("h2", { text: "Orphan notes" });
    container.createEl("p", {
      text: "Orphan notes don't have any incoming or outgoing links. Here are their similar notes to help you get started with linking them!",
      cls: "fyp-modal-desc",
    });

    for (const { file, suggestions } of this.entries) {
      const section = container.createEl("div", { cls: "fyp-orphan-section" });
      const heading = section.createEl("a", { cls: "fyp-similar-title", text: file.basename });
      makeActivatable(heading, () => {
        this.app.workspace.getLeaf(false).openFile(file);
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEWS.ORPHAN_RESCUER);
        this.plugin.activateViewFromSwitcher(SIDEBAR_VIEWS.SIMILAR_NOTES);
      });

      if (suggestions.length === 0) {
        section.createEl("p", { text: "No similar notes found.", cls: "fyp-muted" });
        continue;
      }

      const list = section.createEl("div", { cls: "fyp-orphan-suggestions" });
      for (const r of suggestions) {
        const item = list.createEl("div", { cls: "fyp-orphan-suggestion-item" });
        const link = item.createEl("a", { cls: "fyp-orphan-suggestion-link", text: r.file.basename });
        makeActivatable(link, () => this.app.workspace.getLeaf(false).openFile(r.file));
        item.createEl("span", { cls: "fyp-similar-score", text: ` (${r.score.toFixed(3)})` });
      }
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribeIndexing?.();
  }
}
