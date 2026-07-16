import { ItemView, WorkspaceLeaf, debounce } from "obsidian";
import type { SearchResult, VaultIndex } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";
import { makeActivatable } from "../ui/a11y";
import { renderIndexingStatus } from "../ui/indexing-status";

export const SEARCH_VIEW = "fyp-search";

const SEARCH_DEBOUNCE_MS = 300;

export class SearchView extends ItemView {
  private index: VaultIndex;
  private topK: number;
  private resultsEl!: HTMLElement;
  private results: SearchResult[] = [];
  private selectedIndex = -1;
  private searchGeneration = 0;
  private unsubscribeIndexing: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, index: VaultIndex, topK: number, _plugin: FypPlugin) {
    super(leaf);
    this.index = index;
    this.topK = topK;
  }

  getViewType(): string { return SEARCH_VIEW; }
  getDisplayText(): string { return "Semantic search"; }
  getIcon(): string { return "search"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    createSidebarSwitcher(container, SIDEBAR_VIEWS.SEARCH, (viewType) => {
      if (viewType !== SIDEBAR_VIEWS.SEARCH) {
        this.leaf.setViewState({ type: viewType, active: true });
      }
    });

    if (this.index.isIndexing) {
      this.unsubscribeIndexing = renderIndexingStatus(container, this.index, () => this.onOpen());
      return;
    }

    const inputEl = container.createEl("input", {
      cls: "fyp-search-input",
      attr: { type: "text", placeholder: "Describe what you want in natural language..." },
    });
    this.resultsEl = container.createEl("div", { cls: "fyp-search-results" });

    const debouncedSearch = debounce((query: string) => this.runSearch(query), SEARCH_DEBOUNCE_MS);

    inputEl.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value.trim();
      if (!query) {
        this.searchGeneration++;
        this.results = [];
        this.selectedIndex = -1;
        this.resultsEl.empty();
        return;
      }
      this.resultsEl.empty();
      this.resultsEl.createEl("p", { text: "Searching…", cls: "fyp-muted" });
      debouncedSearch(query);
    });

    inputEl.addEventListener("keydown", (e) => {
      if (this.results.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
        this.renderResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderResults();
      } else if (e.key === "Enter" && this.selectedIndex >= 0) {
        e.preventDefault();
        this.app.workspace.getLeaf(false).openFile(this.results[this.selectedIndex].file);
      } else if (e.key === "Escape") {
        this.selectedIndex = -1;
        this.renderResults();
      }
    });
  }

  private async runSearch(query: string): Promise<void> {
    const gen = ++this.searchGeneration;
    const results = await this.index.search(query, this.topK);
    if (gen !== this.searchGeneration) return; // a newer search superseded this one
    this.results = results;
    this.selectedIndex = -1;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultsEl.empty();
    if (this.results.length === 0) {
      this.resultsEl.createEl("p", { text: "No results.", cls: "fyp-muted" });
      return;
    }
    for (let i = 0; i < this.results.length; i++) {
      const r = this.results[i];
      const item = this.resultsEl.createEl("div", {
        cls: "fyp-similar-item" + (i === this.selectedIndex ? " fyp-item-selected" : ""),
      });
      item.createEl("span", { cls: "fyp-similar-title", text: r.file.basename });
      makeActivatable(item, () => this.app.workspace.getLeaf(false).openFile(r.file));
      item.createEl("span", { cls: "fyp-similar-score", text: r.score.toFixed(3) });
      item.createEl("p", { cls: "fyp-similar-preview", text: r.preview.slice(0, 120) });

      if (i === this.selectedIndex) item.scrollIntoView({ block: "nearest" });
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribeIndexing?.();
  }
}
