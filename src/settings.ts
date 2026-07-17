import { App, PluginSettingTab, Setting } from "obsidian";
import type FypPlugin from "./main";

export interface FypSettings {
  enableIndexing: boolean;
  modelPath: string;
  topK: number;
  llmProvider: "uat" | "openrouter" | "openai-compatible";
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  minSimilarity: number;
  setupCompleted: boolean;
  showWelcomeOnStartup: boolean;
  showNoteTitles: boolean;
}

export const DEFAULT_SETTINGS: FypSettings = {
  enableIndexing: true,
  modelPath: "",
  topK: 6,
  minSimilarity: 0.5,
  llmProvider: "uat",
  llmApiKey: "",
  llmBaseUrl: "https://openrouter.ai/api/v1",
  llmModel: "claude-sonnet",
  setupCompleted: false,
  showWelcomeOnStartup: true,
  showNoteTitles: false,
};

export class FypSettingTab extends PluginSettingTab {
  plugin: FypPlugin;

  constructor(app: App, plugin: FypPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show welcome guide on startup")
      .setDesc("Reopen the setup wizard when Obsidian starts.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showWelcomeOnStartup).onChange(async (v) => {
          this.plugin.settings.showWelcomeOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Enable indexing")
      .setDesc("Most functionality will not work if disabled.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableIndexing).onChange(async (v) => {
          this.plugin.settings.enableIndexing = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show note titles instead of filenames")
      .setDesc("Display each note's frontmatter title (or alias, or first H1 heading) instead of its filename. Useful if you use opaque/unique filenames.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showNoteTitles).onChange(async (v) => {
          this.plugin.settings.showNoteTitles = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl).setName("Custom embedding model path").setDesc("Path to local ONNX model directory (leave blank to use bundled model)").addText((t) =>
      t.setPlaceholder("e.g. /path/to/model").setValue(this.plugin.settings.modelPath).onChange(async (v) => {
        this.plugin.settings.modelPath = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Similar notes: max number of notes").addSlider((s) =>
      s.setLimits(3, 30, 1).setValue(this.plugin.settings.topK).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.topK = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Similar notes: min similarity").setDesc("Results below this cosine similarity threshold are hidden (0 = show all, 1 = exact match only).").addSlider((s) =>
      s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.minSimilarity).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.minSimilarity = v;
        await this.plugin.saveSettings();
      })
    );

    containerEl.createEl("h3", { text: "LLM Provider" });

    new Setting(containerEl).setName("Provider").addDropdown((d) =>
      d
        .addOption("uat", "UAT Testers (project gateway)")
        .addOption("openrouter", "OpenRouter")
        .addOption("openai-compatible", "OpenAI-compatible endpoint")
        .setValue(this.plugin.settings.llmProvider)
        .onChange(async (v) => {
          this.plugin.settings.llmProvider = v as FypSettings["llmProvider"];
          await this.plugin.saveSettings();
          this.display();
        })
    );

    const keyDesc = this.plugin.settings.llmProvider === "uat"
      ? "API key provided by the project author."
      : "Your API key for the selected provider.";

    new Setting(containerEl).setName("API key").setDesc(keyDesc).addText((t) =>
      t.setPlaceholder("sk-…").setValue(this.plugin.settings.llmApiKey).onChange(async (v) => {
        this.plugin.settings.llmApiKey = v;
        await this.plugin.saveSettings();
      })
    );

    if (this.plugin.settings.llmProvider === "openai-compatible") {
      new Setting(containerEl).setName("Base URL").addText((t) =>
        t.setValue(this.plugin.settings.llmBaseUrl).onChange(async (v) => {
          this.plugin.settings.llmBaseUrl = v;
          await this.plugin.saveSettings();
        })
      );
    }

    if (this.plugin.settings.llmProvider !== "uat") {
      new Setting(containerEl).setName("Model").addText((t) =>
        t.setPlaceholder("openai/gpt-4o-mini").setValue(this.plugin.settings.llmModel).onChange(async (v) => {
          this.plugin.settings.llmModel = v;
          await this.plugin.saveSettings();
        })
      );
    }
  }
}
