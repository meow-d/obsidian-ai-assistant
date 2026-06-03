import { ItemView, WorkspaceLeaf } from "obsidian";
import type { VaultIndex } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";

export const SEARCH_VIEW = "fyp-search";

export class SearchView extends ItemView {
  private index: VaultIndex;
  private topK: number;
  private resultsEl!: HTMLElement;
  private plugin: FypPlugin;

  constructor(leaf: WorkspaceLeaf, index: VaultIndex, topK: number, plugin: FypPlugin) {
    super(leaf);
    this.index = index;
    this.topK = topK;
    this.plugin = plugin;
  }

  getViewType(): string { return SEARCH_VIEW; }
  getDisplayText(): string { return "Semantic search"; }
  getIcon(): string { return "search"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    createSidebarSwitcher(container, SIDEBAR_VIEWS.SEARCH, (viewType) => {
      if (viewType !== SIDEBAR_VIEWS.SEARCH) {
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEWS.SEARCH);
        this.plugin.activateViewFromSwitcher(viewType);
      }
    });

    const inputEl = container.createEl("input", {
      cls: "fyp-search-input",
      attr: { type: "text", placeholder: "Describe what you want in natural language..." },
    });
    this.resultsEl = container.createEl("div", { cls: "fyp-search-results" });

    inputEl.addEventListener("input", async (e) => {
      await this.runSearch((e.target as HTMLInputElement).value.trim());
    });
  }

  private async runSearch(query: string): Promise<void> {
    if (!query) return;
    const results = await this.index.search(query, this.topK);
    this.resultsEl.empty();
    if (results.length === 0) {
      this.resultsEl.createEl("p", { text: "No results.", cls: "fyp-muted" });
      return;
    }
    for (const r of results) {
      const item = this.resultsEl.createEl("div", { cls: "fyp-similar-item" });
      const link = item.createEl("a", { cls: "fyp-similar-title", text: r.file.basename });
      link.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(r.file));
      item.createEl("span", { cls: "fyp-similar-score", text: ` (${r.score.toFixed(3)})` });
      item.createEl("p", { cls: "fyp-similar-preview", text: r.preview.slice(0, 120) });
    }
  }

  async onClose(): Promise<void> {}
}
