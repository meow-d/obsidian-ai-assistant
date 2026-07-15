/** Renders a subtle "NN% match" badge with a mini bar, replacing raw cosine-similarity decimals. */
export function renderMatchScore(container: HTMLElement, score: number): HTMLElement {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const badge = container.createEl("span", { cls: "fyp-match-score", attr: { title: `${score.toFixed(3)} cosine similarity` } });
  const track = badge.createEl("span", { cls: "fyp-match-score-track" });
  track.createEl("span", { cls: "fyp-match-score-fill", attr: { style: `width: ${pct}%` } });
  badge.createEl("span", { cls: "fyp-match-score-label", text: `${pct}% match` });
  return badge;
}
