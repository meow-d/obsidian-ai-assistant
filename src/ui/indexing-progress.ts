import { Notice } from "obsidian";

export class IndexingProgress {
  private notice: Notice | null = null;
  private lastUpdateTime = 0;
  private updateInterval = 500;

  show(): void {
    this.notice = new Notice("Indexing your vault...", 0);
  }

  setStatus(msg: string): void {
    this.notice?.setMessage(msg);
  }

  updateProgress(current: number, total: number): void {
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateInterval) return;

    this.lastUpdateTime = now;
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
    if (this.notice) {
      this.notice.setMessage(`Indexing: ${current}/${total} (${percentage}%)`);
    }
  }

  hide(): void {
    if (this.notice) {
      this.notice.hide();
      this.notice = null;
    }
  }
}
