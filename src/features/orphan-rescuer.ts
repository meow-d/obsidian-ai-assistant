import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { VaultIndex, SearchResult } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";

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

    await this.loadOrphans();
    await this.render(container);
  }

  private async loadOrphans(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const orphans = files.filter((f) => this.index.isOrphan(f));

    this.entries = [];
    for (const file of orphans) {
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

    container.createEl("h2", {
      text: "Orphans and similar note preview",
    });
    container.createEl("p", {
      text: "Click to open orphan and switch to similar notes sidebar.",
      cls: "fyp-modal-desc",
    });

    for (const { file, suggestions } of this.entries) {
      const section = container.createEl("div", { cls: "fyp-orphan-section" });
      const heading = section.createEl("a", { cls: "fyp-similar-title", text: file.basename });
      heading.addEventListener("click", async () => {
        this.app.workspace.getLeaf(false).openFile(file);
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEWS.ORPHAN_RESCUER);
        this.plugin.activateViewFromSwitcher(SIDEBAR_VIEWS.SIMILAR_NOTES);
      });

      if (suggestions.length === 0) {
        section.createEl("p", { text: "No similar notes found.", cls: "fyp-muted" });
        continue;
      }

      for (const r of suggestions) {
        const item = section.createEl("div");
        item.createEl("span", { cls: "fyp-orphan-similar", text: r.file.basename });
        item.createEl("span", { cls: "fyp-orphan-similar", text: ` (${r.score.toFixed(3)})` });
      }
    }
  }

  async onClose(): Promise<void> {}
}
