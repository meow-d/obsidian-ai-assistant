import { App, Modal, Setting } from "obsidian";
import type { FypSettings } from "../settings";
import screenshotSmartSuggestions from "../assets/screenshot_smartsuggestions.webp";
import screenshotAgent from "../assets/screenshot_agent.webp";
import screenshotInlineSuggestions from "../assets/screenshot_inlinesuggestions.webp";
import screenshotSearch from "../assets/screenshot_search.webp";
import screenshotOrphan from "../assets/screenshot_orphan.webp";

const TOTAL_PAGES = 8;

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
      7: () => this.renderPage7(),
      8: () => this.renderPage8(),
    };

    pages[this.page]?.();
    this.renderNav();
  }

  private renderPage1(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Welcome to Wikilink AI Assistant (tenative name)!" });
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
        .setDesc("Recommended: deepseek/deepseek-v4-flash")
        .addText((t) =>
          t
            .setPlaceholder("deepseek/deepseek-v4-flash")
            .setValue(this.settings.llmModel)
            .onChange((v) => { this.settings.llmModel = v; })
        );
    }
  }

  private renderPage3(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Smart Suggestions Sidebar" });
    contentEl.createEl("p", {
      text: "The Smart Suggestions sidebar automatically shows similar notes, tag suggestions, folder suggestions, and more.",
    });
    contentEl.createEl("img", { cls: "fyp-modal-screenshot", attr: { src: screenshotSmartSuggestions } });
  }

  private renderPage4(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "AI Agent" });
    contentEl.createEl("p", {
      text: "The AI Agent has full access to your vault. Ask it questions, request summaries, or have it help you write and link notes.",
    });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: "You can also quote selected text from a note directly into the agent chat via the right-click context menu.",
    });
    contentEl.createEl("img", { cls: "fyp-modal-screenshot", attr: { src: screenshotAgent } });
  }

  private renderPage5(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Wikilink Suggestions" });
    contentEl.createEl("p", {
      text: "As you type, the plugin highlights words and phrases that match other notes in your vault. Click a highlight to insert a wikilink.",
    });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: "You can also run \"Scan vault for wikilink suggestions\" from the command palette to review all candidate links across every note at once.",
    });
    contentEl.createEl("img", { cls: "fyp-modal-screenshot", attr: { src: screenshotInlineSuggestions } });
  }

  private renderPage6(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Natural Language Search" });
    contentEl.createEl("p", {
      text: "Search your vault by meaning, not just keywords. Describe what you're looking for and the plugin finds notes that match semantically, even if they don't share exact wording.",
    });
    contentEl.createEl("img", { cls: "fyp-modal-screenshot", attr: { src: screenshotSearch } });
  }

  private renderPage7(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Orphan Note Rescuer" });
    contentEl.createEl("p", {
      text: "Notes with no incoming or outgoing links are easy to lose track of. The Orphan Note Rescuer finds these isolated notes and suggests related notes to link them to.",
    });
    contentEl.createEl("img", { cls: "fyp-modal-screenshot", attr: { src: screenshotOrphan } });
  }

  private renderPage8(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "You're all set!" });
    contentEl.createEl("p", {
      text: "After you click Finish, the plugin will begin indexing your vault. This may take a few minutes to hours depending on the size of your vault.",
    });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: "You can re-open this guide any time from Settings > FYP Plugin > Show welcome guide on startup.",
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
      finishBtn.addEventListener("click", () => {
        this.close();
        void this.onSetupComplete();
      });
    }

    void pageIndicator;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
