import type { VaultIndex } from "../core/vault-index";

/**
 * Renders a centered "vault is indexing" panel (progress bar, model name, flavour text)
 * into `container` and keeps it live-updated until the index finishes or `container`
 * is torn down elsewhere. Returns an unsubscribe function to call on view close.
 */
export function renderIndexingStatus(container: HTMLElement, index: VaultIndex, onDone: () => void): () => void {
  const panel = container.createEl("div", { cls: "fyp-indexing-panel" });
  panel.createEl("div", { cls: "fyp-indexing-spinner" });
  panel.createEl("p", { cls: "fyp-indexing-flavour", text: "Indexing your vault… this can take a while!" });
  const barTrack = panel.createEl("div", { cls: "fyp-indexing-bar-track" });
  const barFill = barTrack.createEl("div", { cls: "fyp-indexing-bar-fill" });
  const detail = panel.createEl("p", { cls: "fyp-indexing-detail fyp-muted" });
  panel.createEl("p", { cls: "fyp-indexing-model fyp-muted", text: `Model: ${index.modelName}` });

  const update = () => {
    const state = index.indexingStatus;
    if (!state) {
      unsubscribe();
      onDone();
      return;
    }
    const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
    barFill.setAttribute("style", `width: ${pct}%`);
    detail.setText(`${state.status} (${state.current}/${state.total} notes, ${pct}%)`);
  };

  const unsubscribe = index.onIndexingChange(update);
  update();
  return unsubscribe;
}
