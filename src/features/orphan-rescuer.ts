import { App, ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { VaultIndex, SearchResult } from "../core/vault-index";
import type FypPlugin from "../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../ui/sidebar-switcher";
import { makeActivatable } from "../ui/a11y";
import { renderIndexingStatus } from "../ui/indexing-status";
import { getDisplayTitle } from "../core/note-title";

export const ORPHAN_RESCUER_VIEW = "fyp-orphan-rescuer";

interface OrphanEntry {
  file: TFile;
  suggestions: SearchResult[];
}

type ScanStatus = "idle" | "scanning" | "done" | "cancelled";

/**
 * Owns the orphan scan outside any view instance, since Obsidian recreates
 * OrphanRescuerView each time the sidebar switches back to this tab. Session-only:
 * resets on plugin reload, not persisted to disk.
 */
class OrphanScanState {
  status: ScanStatus = "idle";
  entries: OrphanEntry[] = [];
  current = 0;
  total = 0;

  private cancelRequested = false;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  requestCancel(): void {
    this.cancelRequested = true;
  }

  async run(app: App, index: VaultIndex, topK: number): Promise<void> {
    this.status = "scanning";
    this.cancelRequested = false;
    this.entries = [];
    this.current = 0;

    const files = app.vault.getMarkdownFiles();
    const orphans = files.filter((f) => index.isOrphan(f));
    this.total = orphans.length;
    this.notify();

    for (let i = 0; i < orphans.length; i++) {
      if (this.cancelRequested) {
        this.status = "cancelled";
        this.notify();
        return;
      }

      const file = orphans[i];
      this.current = i;
      this.notify();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      const emb = await index.getEmbedding(file.path);
      if (emb) {
        const suggestions = (await index.searchByEmbedding(emb, topK, file.path))
          .filter((r) => r.score > 0.5)
          .slice(0, 3);
        this.entries.push({ file, suggestions });
      }
    }

    this.status = this.cancelRequested ? "cancelled" : "done";
    this.notify();
  }
}

const scanState = new OrphanScanState();

export class OrphanRescuerView extends ItemView {
  private index: VaultIndex;
  private topK: number;
  private plugin: FypPlugin;
  private unsubscribeIndexing: (() => void) | null = null;
  private unsubscribeScan: (() => void) | null = null;

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
        this.leaf.setViewState({ type: viewType, active: true });
      }
    });

    if (this.index.isIndexing) {
      this.unsubscribeIndexing = renderIndexingStatus(container, this.index, () => this.onOpen());
      return;
    }

    this.unsubscribeScan = scanState.subscribe(() => this.render(container));

    if (scanState.status === "idle") {
      // Fire-and-forget: keeps running even if the user switches tabs.
      void scanState.run(this.app, this.index, this.topK);
    }

    this.render(container);
  }

  private startRescan(): void {
    void scanState.run(this.app, this.index, this.topK);
  }

  private render(container: HTMLElement): void {
    const switcherEl = container.querySelector(".fyp-sidebar-switcher");
    container.empty();
    if (switcherEl) container.appendChild(switcherEl);

    if (scanState.status === "scanning") {
      this.renderScanning(container);
      return;
    }

    if (scanState.status === "cancelled") {
      container.createEl("p", { text: "Orphan scan cancelled.", cls: "fyp-muted" });
      const btn = container.createEl("button", { text: "Scan for orphan notes" });
      btn.addEventListener("click", () => this.startRescan());
      return;
    }

    this.renderResults(container);
  }

  private renderScanning(container: HTMLElement): void {
    const panel = container.createEl("div", { cls: "fyp-indexing-panel" });
    panel.createEl("div", { cls: "fyp-indexing-spinner" });
    panel.createEl("p", { cls: "fyp-indexing-flavour", text: "Scanning vault for orphan notes…" });
    panel.createEl("p", {
      cls: "fyp-indexing-detail",
      text: `${scanState.current}/${scanState.total} notes`,
    });

    const cancelBtn = panel.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      scanState.requestCancel();
      this.leaf.setViewState({ type: SIDEBAR_VIEWS.SIMILAR_NOTES, active: true });
    });
  }

  private renderResults(container: HTMLElement): void {
    const header = container.createEl("div", { cls: "fyp-orphan-header" });
    header.createEl("h2", { text: "Orphan notes" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.addEventListener("click", () => this.startRescan());

    if (scanState.entries.length === 0) {
      container.createEl("p", { text: "No orphan notes found.", cls: "fyp-muted" });
      return;
    }

    container.createEl("p", {
      text: "Orphan notes don't have any incoming or outgoing links. Here are their similar notes to help you get started with linking them!",
      cls: "fyp-modal-desc",
    });

    for (const { file, suggestions } of scanState.entries) {
      const section = container.createEl("div", { cls: "fyp-orphan-section" });
      const heading = section.createEl("a", { cls: "fyp-similar-title", text: getDisplayTitle(this.app, file, this.plugin.settings.showNoteTitles) });
      makeActivatable(heading, () => {
        this.app.workspace.getLeaf(false).openFile(file);
        this.leaf.setViewState({ type: SIDEBAR_VIEWS.SIMILAR_NOTES, active: true });
      });

      if (suggestions.length === 0) {
        section.createEl("p", { text: "No similar notes found.", cls: "fyp-muted" });
        continue;
      }

      const list = section.createEl("div", { cls: "fyp-orphan-suggestions" });
      for (const r of suggestions) {
        const item = list.createEl("div", { cls: "fyp-orphan-suggestion-item" });
        const link = item.createEl("a", { cls: "fyp-orphan-suggestion-link", text: getDisplayTitle(this.app, r.file, this.plugin.settings.showNoteTitles) });
        makeActivatable(link, () => this.app.workspace.getLeaf(false).openFile(r.file));
        item.createEl("span", { cls: "fyp-similar-score", text: r.score.toFixed(3)});
      }
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribeIndexing?.();
    this.unsubscribeScan?.();
  }
}
