import { App, Modal, Setting } from "obsidian";
import type { FypSettings } from "../settings";
import screenshotSmartSuggestions from "../assets/screenshot_smartsuggestions.webp";
import screenshotAgent from "../assets/screenshot_agent.webp";
import screenshotInlineSuggestions from "../assets/screenshot_inlinesuggestions.webp";
import screenshotSearch from "../assets/screenshot_search.webp";
import screenshotOrphan from "../assets/screenshot_orphan.webp";

const TOTAL_PAGES = 8;

interface SimplePage {
  title: string;
  paragraphs: { text: string; cls?: string }[];
  image?: string;
}

/** Pages that are just static text/screenshot; page 2 (settings) is built separately. */
const SIMPLE_PAGES: Record<number, SimplePage> = {
  1: {
    title: "Welcome to Wikilink AI Assistant (tenative name)!",
    paragraphs: [
      { text: "This plugin brings AI-powered knowledge management to your Obsidian vault. It uses custom fine-tuned embedding models to understand your notes and surface connections you might have missed." },
      { text: "This short guide will walk you through configuration and the main features." },
    ],
  },
  3: {
    title: "Smart Suggestions Sidebar",
    paragraphs: [
      { text: "The Smart Suggestions sidebar automatically shows similar notes, tag suggestions, folder suggestions, and more." },
    ],
    image: screenshotSmartSuggestions,
  },
  4: {
    title: "AI Agent",
    paragraphs: [
      { text: "The AI Agent has full access to your vault. Ask it questions, request summaries, or have it help you write and link notes." },
      { text: "You can also quote selected text from a note directly into the agent chat via the right-click context menu.", cls: "fyp-modal-desc" },
    ],
    image: screenshotAgent,
  },
  5: {
    title: "Wikilink Suggestions",
    paragraphs: [
      { text: "As you type, the plugin highlights words and phrases that match other notes in your vault. Click a highlight to insert a wikilink." },
      { text: "You can also run \"Scan vault for wikilink suggestions\" from the command palette to review all candidate links across every note at once.", cls: "fyp-modal-desc" },
    ],
    image: screenshotInlineSuggestions,
  },
  6: {
    title: "Natural Language Search",
    paragraphs: [
      { text: "Search your vault by meaning, not just keywords. Describe what you're looking for and the plugin finds notes that match semantically, even if they don't share exact wording." },
    ],
    image: screenshotSearch,
  },
  7: {
    title: "Orphan Note Rescuer",
    paragraphs: [
      { text: "Notes with no incoming or outgoing links are easy to lose track of. The Orphan Note Rescuer finds these isolated notes and suggests related notes to link them to." },
    ],
    image: screenshotOrphan,
  },
  8: {
    title: "You're all set!",
    paragraphs: [
      { text: "After you click Finish, the plugin will begin indexing your vault. This may take a few minutes to hours depending on the size of your vault." },
      { text: "You can re-open this guide any time from Settings > FYP Plugin > Show welcome guide on startup.", cls: "fyp-modal-desc" },
    ],
  },
};

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

    if (this.page === 2) {
      this.renderSettingsPage();
    } else {
      this.renderSimplePage(SIMPLE_PAGES[this.page]);
    }

    this.renderNav();
  }

  private renderSimplePage(page: SimplePage): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: page.title });
    for (const p of page.paragraphs) {
      contentEl.createEl("p", { text: p.text, cls: p.cls });
    }
    if (page.image) {
      contentEl.createEl("img", { cls: "fyp-modal-screenshot", attr: { src: page.image } });
    }
  }

  private renderSettingsPage(): void {
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

    new Setting(contentEl)
      .setName("API Key")
      .setDesc("Your API key for the selected provider")
      .addText((t) =>
        t
          .setPlaceholder("sk-…")
          .setValue(this.settings.llmApiKey)
          .onChange((v) => { this.settings.llmApiKey = v; })
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
