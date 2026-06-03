import { App, Modal, Notice, TFile } from "obsidian";
import { extractCandidates, getLinkedPhrases } from "../core/nlp";
import { embed } from "../core/embedder";
import type { VaultIndex } from "../core/vault-index";

const MIN_SCORE = 0.45;

type VaultSuggestion = { sourceFile: TFile; phrase: string; targetFile: TFile; score: number };

class VaultWikilinkModal extends Modal {
  private suggestions: VaultSuggestion[];

  constructor(app: App, suggestions: VaultSuggestion[]) {
    super(app);
    this.suggestions = suggestions;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Vault wikilink suggestions" });
    contentEl.createEl("p", {
      text: `${this.suggestions.length} candidate phrase${this.suggestions.length !== 1 ? "s" : ""} found across the vault.`,
      cls: "fyp-modal-desc",
    });

    const bySource = new Map<string, VaultSuggestion[]>();
    for (const s of this.suggestions) {
      if (!bySource.has(s.sourceFile.path)) bySource.set(s.sourceFile.path, []);
      bySource.get(s.sourceFile.path)!.push(s);
    }

    for (const [, group] of bySource) {
      const section = contentEl.createEl("div", { cls: "fyp-orphan-section" });
      section.createEl("strong", { text: group[0].sourceFile.basename });

      for (const s of group) {
        const row = section.createEl("div", { cls: "fyp-orphan-row" });
        row.createEl("code", { text: s.phrase });
        row.createEl("span", { text: ` → [[${s.targetFile.basename}]]`, cls: "fyp-similar-score" });
        row.createEl("span", { text: ` (${s.score.toFixed(2)})`, cls: "fyp-similar-score" });

        const btn = row.createEl("button", { text: "Insert link" });
        btn.addEventListener("click", async () => {
          const content = await this.app.vault.read(s.sourceFile);
          const idx = content.indexOf(s.phrase);
          if (idx === -1) {
            new Notice(`Phrase not found in "${s.sourceFile.basename}" — note may have changed.`);
            return;
          }
          const updated =
            content.slice(0, idx) +
            `[[${s.targetFile.basename}|${s.phrase}]]` +
            content.slice(idx + s.phrase.length);
          await this.app.vault.modify(s.sourceFile, updated);
          btn.textContent = "Linked!";
          btn.disabled = true;
        });
      }
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

export async function scanVaultWikilinks(app: App, index: VaultIndex): Promise<void> {
  const files = app.vault.getMarkdownFiles();
  const progressNotice = new Notice(`Scanning vault… 0 / ${files.length}`, 0);
  const suggestions: VaultSuggestion[] = [];

  try {
    for (let i = 0; i < files.length; i++) {
      progressNotice.setMessage(`Scanning vault… ${i + 1} / ${files.length}`);
      const file = files[i];
      const text = await app.vault.cachedRead(file);
      const candidates = extractCandidates(text);
      const linked = getLinkedPhrases(text);
      const unlinked = candidates.filter((c) => !linked.has(c.toLowerCase()));
      if (unlinked.length === 0) continue;

      const embeddings = await embed(unlinked);
      for (let j = 0; j < unlinked.length; j++) {
        const results = await index.searchByEmbedding(embeddings[j], 1, file.path);
        if (results.length > 0 && results[0].score >= MIN_SCORE) {
          suggestions.push({ sourceFile: file, phrase: unlinked[j], targetFile: results[0].file, score: results[0].score });
        }
      }
    }
  } finally {
    progressNotice.hide();
  }

  if (suggestions.length === 0) {
    new Notice("No wikilink candidates found across the vault.");
    return;
  }

  new VaultWikilinkModal(app, suggestions).open();
}
