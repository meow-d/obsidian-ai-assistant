import { App, Modal, Setting } from "obsidian";
import type { FypSettings } from "../settings";

const TOTAL_PAGES = 6;

export class WelcomeModal extends Modal {
  private settings: FypSettings;
  private onSetupComplete: () => Promise<void>;
  private page = 1;

  constructor(app: App, settings: FypSettings, onSetupComplete: () => Promise<void>) {
    super(app);
    this.settings = settings;
    this.onSetupComplete = onSetupComplete;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const pages: Record<number, () => void> = {
      1: () => this.renderPage1(),
      2: () => this.renderPage2(),
      3: () => this.renderPage3(),
      4: () => this.renderPage4(),
      5: () => this.renderPage5(),
      6: () => this.renderPage6(),
    };

    pages[this.page]?.();
    this.renderNav();
  }

  private renderPage1(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Welcome to FYP Plugin!" });
    contentEl.createEl("p", {
      text: "This plugin brings AI-powered knowledge management to your Obsidian vault. It uses custom fine-tuned embedding models to understand your notes and surface connections you might have missed.",
    });
    contentEl.createEl("p", {
      text: "This short guide will walk you through configuration and the main features.",
    });
  }

  private renderPage2(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Configure Options" });

    new Setting(contentEl)
      .setName("LLM Provider")
      .setDesc("Select where your AI models will run")
      .addDropdown((d) =>
        d
          .addOption("uat", "UAT Testers")
          .addOption("openrouter", "OpenRouter")
          .addOption("openai-compatible", "Custom OpenAI-compatible endpoint")
          .setValue(this.settings.llmProvider)
          .onChange((v) => {
            this.settings.llmProvider = v as FypSettings["llmProvider"];
            this.render();
          })
      );

    const keyDesc =
      this.settings.llmProvider === "uat"
        ? "API key provided for UAT (will be auto-configured if you select this)"
        : "Your API key for the selected provider";

    new Setting(contentEl)
      .setName("API Key")
      .setDesc(keyDesc)
      .addText((t) =>
        t
          .setPlaceholder(this.settings.llmProvider === "uat" ? "Auto-configured" : "sk-…")
          .setValue(this.settings.llmApiKey)
          .onChange((v) => { this.settings.llmApiKey = v; })
          .setDisabled(this.settings.llmProvider === "uat")
      );

    if (this.settings.llmProvider === "openai-compatible") {
      new Setting(contentEl)
        .setName("Base URL")
        .setDesc("API endpoint URL")
        .addText((t) =>
          t
            .setPlaceholder("https://api.example.com/v1")
            .setValue(this.settings.llmBaseUrl)
            .onChange((v) => { this.settings.llmBaseUrl = v; })
        );
    }

    if (this.settings.llmProvider !== "uat") {
      new Setting(contentEl)
        .setName("Model")
        .setDesc("Recommended: claude-sonnet-4-20250514 or deepseek/deepseek-v3")
        .addText((t) =>
          t
            .setPlaceholder("claude-sonnet-4-20250514")
            .setValue(this.settings.llmModel)
            .onChange((v) => { this.settings.llmModel = v; })
        );
    } else {
      new Setting(contentEl)
        .setName("Model")
        .setDesc("Using UAT testers gateway")
        .addDropdown((d) =>
          d
            .addOption("claude-sonnet", "Claude Sonnet")
            .addOption("deepseek-v4-pro", "Deepseek V4 Pro")
            .setValue(this.settings.llmModel)
            .onChange((v) => { this.settings.llmModel = v; })
        );
    }
  }

  private renderPage3(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Smart Suggestions Sidebar" });
    contentEl.createEl("p", {
      text: "The Smart Suggestions sidebar appears on the right panel. It automatically shows notes that are semantically related to the one you're currently editing.",
    });
    contentEl.createEl("p", {
      text: "It also surfaces tag suggestions, folder suggestions, and alerts you when a note might benefit from being split into smaller notes.",
    });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: "Screenshots will be added here.",
    });
  }

  private renderPage4(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "AI Agent" });
    contentEl.createEl("p", {
      text: "The AI Agent has full access to your vault. Ask it questions, request summaries, or have it help you write and link notes.",
    });
    contentEl.createEl("p", {
      text: "Open it from the sidebar switcher or via the command palette with \"Open AI agent chat\".",
    });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: "You can also quote selected text from a note directly into the agent chat via the right-click context menu.",
    });
  }

  private renderPage5(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Wikilink Suggestions" });
    contentEl.createEl("p", {
      text: "As you type, the plugin highlights words and phrases that match other notes in your vault. Click a highlight to insert a wikilink.",
    });
    contentEl.createEl("p", {
      text: "You can also run \"Scan vault for wikilink suggestions\" from the command palette to review all candidate links across every note at once.",
    });
  }

  private renderPage6(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "You're all set!" });
    contentEl.createEl("p", {
      text: "After you click Finish, the plugin will begin indexing your vault. This may take a few minutes to hours depending on the size of your vault.",
    });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: "You can re-open this guide any time from Settings -> FYP Plugin -> Show welcome guide on startup.",
    });
  }

  private renderNav(): void {
    const { contentEl } = this;
    const nav = contentEl.createEl("div", { cls: "fyp-welcome-nav" });

    const pageIndicator = nav.createEl("span", {
      cls: "fyp-welcome-page-indicator",
      text: `${this.page} / ${TOTAL_PAGES}`,
    });

    const btnRow = nav.createEl("div", { cls: "fyp-welcome-buttons" });

    if (this.page > 1) {
      const backBtn = btnRow.createEl("button", { text: "Back" });
      backBtn.addEventListener("click", () => {
        this.page--;
        this.render();
      });
    }

    if (this.page < TOTAL_PAGES) {
      const nextBtn = btnRow.createEl("button", { cls: "mod-cta", text: "Next" });
      nextBtn.addEventListener("click", () => {
        this.page++;
        this.render();
      });
    } else {
      const finishBtn = btnRow.createEl("button", { cls: "mod-cta", text: "Finish" });
      finishBtn.addEventListener("click", async () => {
        await this.onSetupComplete();
        this.close();
      });
    }

    void pageIndicator;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
