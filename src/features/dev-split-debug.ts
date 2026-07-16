import { App, Modal, Notice, TFile } from "obsidian";
import { analyseSplit, NoteSplitModal } from "./note-split";
import type { FypSettings } from "../settings";

interface DebugEntry {
  file: TFile;
  status: "triggered" | "below-threshold" | "too-short" | "error";
  score?: number;
  clusterCount?: number;
  intraSim?: number;
  interSim?: number;
  balance?: number;
  sentenceCount?: number;
  error?: string;
}

export async function runDevSplitDebug(app: App, settings: FypSettings): Promise<void> {
  const files = app.vault.getMarkdownFiles();
  new Notice(`[DEV] Analysing ${files.length} notes for split candidates…`);

  const results: DebugEntry[] = [];

  for (const file of files) {
    try {
      const text = await app.vault.cachedRead(file);
      const analysis = await analyseSplit(text);
      if (analysis) {
        results.push({
          file,
          status: "triggered",
          score: analysis.score,
          clusterCount: analysis.clusters.length,
          intraSim: analysis.intraSim,
          interSim: analysis.interSim,
          balance: analysis.balance,
          sentenceCount: analysis.clusters.reduce((s, c) => s + c.sentences.length, 0),
        });
      } else {
        results.push({ file, status: "below-threshold" });
      }
    } catch (e) {
      results.push({ file, status: "error", error: (e as Error).message });
    }
  }

  new DevSplitDebugModal(app, results, settings).open();
}

class DevSplitDebugModal extends Modal {
  private results: DebugEntry[];
  private settings: FypSettings;

  constructor(app: App, results: DebugEntry[], settings: FypSettings) {
    super(app);
    this.results = results;
    this.settings = settings;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.style.width = "800px";
    this.modalEl.style.maxHeight = "80vh";
    this.modalEl.style.overflowY = "auto";

    const triggered = this.results.filter(r => r.status === "triggered");
    const errors = this.results.filter(r => r.status === "error");

    contentEl.createEl("h2", { text: "[DEV] Note split bulk analysis" });
    contentEl.createEl("p", {
      text: `${this.results.length} notes analysed · ${triggered.length} triggered · ${errors.length} errors`,
      cls: "fyp-modal-desc",
    });

    if (triggered.length > 0) this.renderTriggeredTable(contentEl, triggered);
    if (errors.length > 0) this.renderErrorList(contentEl, errors);
  }

  private renderTriggeredTable(contentEl: HTMLElement, triggered: DebugEntry[]): void {
    contentEl.createEl("h3", { text: "Triggered" });
    const table = contentEl.createEl("table");
    const head = table.createEl("thead").createEl("tr");
    for (const col of ["Note", "Score", "Clusters", "Sentences", "Intra sim", "Inter sim", "Balance", "Actions"]) {
      head.createEl("th", { text: col });
    }
    const body = table.createEl("tbody");
    for (const r of triggered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
      this.renderTriggeredRow(body, r);
    }
  }

  private renderTriggeredRow(body: HTMLElement, r: DebugEntry): void {
    const row = body.createEl("tr");
    row.createEl("td", { text: r.file.basename });
    row.createEl("td", { text: (r.score ?? 0).toFixed(3) });
    row.createEl("td", { text: String(r.clusterCount ?? 0) });
    row.createEl("td", { text: String(r.sentenceCount ?? 0) });
    row.createEl("td", { text: (r.intraSim ?? 0).toFixed(3) });
    row.createEl("td", { text: (r.interSim ?? 0).toFixed(3) });
    row.createEl("td", { text: (r.balance ?? 0).toFixed(3) });

    const actionsTd = row.createEl("td");
    const openBtn = actionsTd.createEl("button", { text: "Open" });
    openBtn.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(r.file));
    const splitBtn = actionsTd.createEl("button", { text: "Split…" });
    splitBtn.addEventListener("click", async () => {
      const text = await this.app.vault.cachedRead(r.file);
      const analysis = await analyseSplit(text);
      if (analysis) new NoteSplitModal(this.app, r.file, analysis, this.settings).open();
    });
  }

  private renderErrorList(contentEl: HTMLElement, errors: DebugEntry[]): void {
    contentEl.createEl("h3", { text: "Errors" });
    for (const r of errors) {
      const row = contentEl.createEl("div");
      row.createEl("strong", { text: r.file.path });
      row.createEl("span", { text: `: ${r.error}` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
