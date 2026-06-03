import { App, Modal, Notice, TFile } from "obsidian";
import type { VaultIndex } from "../core/vault-index";

class TagSuggestModal extends Modal {
  private file: TFile;
  private ranked: Array<{ tag: string; score: number }>;

  constructor(app: App, file: TFile, ranked: Array<{ tag: string; score: number }>) {
    super(app);
    this.file = file;
    this.ranked = ranked;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Suggested tags" });

    for (const { tag, score } of this.ranked) {
      const row = contentEl.createEl("div", { cls: "fyp-tag-row" });
      row.createEl("code", { text: tag });
      row.createEl("span", { text: `  score: ${score.toFixed(3)}`, cls: "fyp-similar-score" });
      const btn = row.createEl("button", { text: "Add" });
      btn.addEventListener("click", async () => {
        await this.app.fileManager.processFrontMatter(this.file, (fm) => {
          if (!Array.isArray(fm.tags)) fm.tags = fm.tags ? [fm.tags] : [];
          if (!fm.tags.includes(tag)) fm.tags.push(tag);
        });
        btn.textContent = "Added!";
        btn.disabled = true;
      });
    }

    if (this.ranked.length === 0) {
      contentEl.createEl("p", { text: "No tag suggestions - similar notes have no tags." });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export async function computeTagSuggestions(
  app: App, index: VaultIndex, file: TFile, topK = 10
): Promise<Array<{ tag: string; score: number }>> {
  const emb = await index.getEmbedding(file.path);
  if (!emb) return [];

  const similar = await index.searchByEmbedding(emb, topK, file.path);
  const currentCache = app.metadataCache.getFileCache(file);
  const currentTags = new Set<string>((currentCache?.tags ?? []).map((t) => t.tag.replace(/^#/, "")));

  const tagScores = new Map<string, number>();
  for (const r of similar) {
    const cache = app.metadataCache.getFileCache(r.file);
    for (const tagObj of cache?.tags ?? []) {
      const tag = tagObj.tag.replace(/^#/, "");
      if (currentTags.has(tag)) continue;
      tagScores.set(tag, (tagScores.get(tag) ?? 0) + r.score);
    }
  }

  return Array.from(tagScores.entries())
    .map(([tag, score]) => ({ tag, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export async function openTagSuggestions(app: App, index: VaultIndex, file: TFile, topK = 10): Promise<void> {
  const emb = await index.getEmbedding(file.path);
  if (!emb) {
    new Notice("Note not indexed yet. Run 'Rebuild embedding index' first.");
    return;
  }
  const ranked = await computeTagSuggestions(app, index, file, topK);
  new TagSuggestModal(app, file, ranked).open();
}
