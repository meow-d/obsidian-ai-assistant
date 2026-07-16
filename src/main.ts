import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { log, error } from "./core/log";
import { type FypSettings, FypSettingTab, DEFAULT_SETTINGS } from "./settings";
import { VaultIndex } from "./core/vault-index";
import { CacheManager } from "./core/cache-manager";
import { SimilarNotesView, SIMILAR_NOTES_VIEW } from "./features/similar-notes";
import { AgentView, AGENT_VIEW } from "./features/agent/index";
import { SearchView, SEARCH_VIEW } from "./features/search";
import { OrphanRescuerView, ORPHAN_RESCUER_VIEW } from "./features/orphan-rescuer";
import { createWikilinkCandidateExtension } from "./features/wikilink-suggestions";
import { registerQuoteInChat } from "./features/quote-in-chat";
import { scanVaultWikilinks } from "./features/vault-wikilink-scan";
import { runDevSplitDebug } from "./features/dev-split-debug";
import { WelcomeModal } from "./ui/welcome-modal";
import { IndexingProgress } from "./ui/indexing-progress";

export default class FypPlugin extends Plugin {
  settings: FypSettings;
  index: VaultIndex;
  private cacheManager: CacheManager;
  private storedConversations: unknown[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();

    this.cacheManager = new CacheManager(this.app, this.manifest.dir!);
    this.index = new VaultIndex(this.app, this.settings.modelPath, this.cacheManager);

    this.addSettingTab(new FypSettingTab(this.app, this));

    // Views
    this.registerView(SIMILAR_NOTES_VIEW, (leaf: WorkspaceLeaf) =>
      new SimilarNotesView(leaf, this.index, this.settings.topK, this.settings.minSimilarity, this)
    );
    this.registerView(AGENT_VIEW, (leaf: WorkspaceLeaf) =>
      new AgentView(leaf, this.index, this.app, this.settings, this)
    );
    this.registerView(SEARCH_VIEW, (leaf: WorkspaceLeaf) =>
      new SearchView(leaf, this.index, this.settings.topK, this)
    );
    this.registerView(ORPHAN_RESCUER_VIEW, (leaf: WorkspaceLeaf) =>
      new OrphanRescuerView(leaf, this.index, this.settings.topK, this)
    );

    // Clean up any persisted leaves from removed view types
    this.app.workspace.detachLeavesOfType("fyp-resurface");

    // Ribbon icons
    this.addRibbonIcon("files", "Similar notes", () => {
      this.activateView(SIMILAR_NOTES_VIEW);
    });

    // CM6 inline wikilink candidate decorations
    this.registerEditorExtension(createWikilinkCandidateExtension(this.app, this.index));

    // Commands
    this.addCommand({
      id: "semantic-search",
      name: "Search notes (semantic)",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "s" }],
      callback: () => this.activateView(SEARCH_VIEW),
    });
    this.addCommand({
      id: "open-similar-notes",
      name: "Open similar notes sidebar",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "l" }],
      callback: () => this.activateView(SIMILAR_NOTES_VIEW),
    });
    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild embedding index",
      callback: () => this.buildIndex(),
    });
    this.addCommand({
      id: "find-orphan-notes",
      name: "Find orphan notes",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "o" }],
      callback: () => this.activateView(ORPHAN_RESCUER_VIEW),
    });
    this.addCommand({
      id: "open-agent",
      name: "Open AI agent chat",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "a" }],
      callback: () => this.activateView(AGENT_VIEW),
    });
    this.addCommand({
      id: "scan-vault-wikilink-candidates",
      name: "Scan vault for wikilink suggestions",
      callback: () => scanVaultWikilinks(this.app, this.index),
    });

    // DEV: comment out before shipping
    this.addCommand({
      id: "dev-note-split-bulk-debug",
      name: "[DEV] Bulk note-split analysis on entire vault",
      callback: () => runDevSplitDebug(this.app, this.settings),
    });

    // Editor context menu: quote in agent chat
    registerQuoteInChat(this);

    // Incremental vault index updates
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!this.settings.enableIndexing || !file.path.endsWith(".md")) return;
        log(`[plugin] vault modify: "${file.path}"`);
        const tf = this.app.vault.getAbstractFileByPath(file.path);
        if (tf instanceof TFile) await this.index.updateFile(tf);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (!this.settings.enableIndexing) return;
        log(`[plugin] vault delete: "${file.path}"`);
        await this.index.removeFile(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!this.settings.enableIndexing) return;
        log(`[plugin] vault rename: "${oldPath}" → "${file.path}"`);
        await this.index.removeFile(oldPath);
        if (file.path.endsWith(".md")) {
          const tf = this.app.vault.getAbstractFileByPath(file.path);
          if (tf instanceof TFile) await this.index.updateFile(tf);
        }
      })
    );


    this.app.workspace.onLayoutReady(async () => {
      // Open similar notes panel by default, but don't steal the sidebar
      // if one of our other views is already open there.
      const anyFypViewOpen = [SIMILAR_NOTES_VIEW, AGENT_VIEW, SEARCH_VIEW, ORPHAN_RESCUER_VIEW].some(
        (type) => this.app.workspace.getLeavesOfType(type).length > 0
      );
      if (!anyFypViewOpen) {
        await this.activateView(SIMILAR_NOTES_VIEW);
      }

      if (this.settings.showWelcomeOnStartup) {
        new WelcomeModal(this.app, this.settings, async () => {
          this.settings.setupCompleted = true;
          this.settings.showWelcomeOnStartup = false;
          await this.saveSettings();
          if (this.settings.enableIndexing) {
            await this.buildIndex();
          }
        }).open();
      } else if (this.settings.enableIndexing) {
        await this.buildIndex();
      }
    });
  }

  async onunload(): Promise<void> {
    for (const type of [SIMILAR_NOTES_VIEW, AGENT_VIEW, SEARCH_VIEW, ORPHAN_RESCUER_VIEW]) {
      this.app.workspace.detachLeavesOfType(type);
    }
  }

  private async buildIndex(): Promise<void> {
    const progress = new IndexingProgress();
    progress.show();

    try {
      await this.index.build(
        (current, total) => progress.updateProgress(current, total),
        (msg) => progress.setStatus(msg),
      );
      progress.hide();
      new Notice(`${this.index.size} notes indexed.`);

      // Refresh any open similar notes views now that the index is ready
      for (const leaf of this.app.workspace.getLeavesOfType(SIMILAR_NOTES_VIEW)) {
        (leaf.view as SimilarNotesView).refresh();
      }
    } catch (e) {
      progress.hide();
      new Notice("Error building index. Check console for details.");
      error("[plugin] index build error:", e);
    }
  }

  private async activateView(viewType: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(viewType);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: viewType, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }


  public activateViewFromSwitcher(viewType: string): void {
    switch (viewType) {
      case "fyp-similar-notes":
        this.activateView("fyp-similar-notes");
        break;
      case "fyp-agent":
        this.activateView("fyp-agent");
        break;
      case "fyp-search":
        this.activateView("fyp-search");
        break;
      case "fyp-orphan-rescuer":
        this.activateView("fyp-orphan-rescuer");
        break;
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.storedConversations = Array.isArray(data.agentConversations) ? data.agentConversations : [];
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, agentConversations: this.storedConversations });
  }

  getAgentConversations(): unknown[] {
    return this.storedConversations;
  }

  async saveAgentConversations(convs: unknown[]): Promise<void> {
    this.storedConversations = convs;
    await this.saveData({ ...this.settings, agentConversations: this.storedConversations });
  }

}
