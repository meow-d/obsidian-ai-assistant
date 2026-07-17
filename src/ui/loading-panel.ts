import "obsidian";

/** Renders the same spinner-and-flavour-text panel used by the indexing status, for shorter waits that don't have a progress total. */
export function renderLoadingPanel(container: HTMLElement, text: string): void {
  const panel = container.createEl("div", { cls: "fyp-indexing-panel" });
  panel.createEl("div", { cls: "fyp-indexing-spinner" });
  panel.createEl("p", { cls: "fyp-indexing-flavour", text });
}
