import { App, TFile, TFolder } from "obsidian";
import type { VaultIndex } from "../core/vault-index";

const NEIGHBOUR_K = 30;
const MIN_SCORE = 0.3;
const MIN_NEIGHBOUR_SIMILARITY = 0.3;

function folderSize(folder: TFolder): number {
  let count = 0;
  for (const child of folder.children) {
    if (!("children" in child) && (child as any).extension === "md") count++;
  }
  return count;
}

export async function computeFolderSuggestions(
  app: App, index: VaultIndex, file: TFile
): Promise<Array<{ folder: TFolder; score: number }>> {
  const emb = await index.getEmbedding(file.path);
  if (!emb) return [];

  const neighbours = await index.searchByEmbedding(emb, NEIGHBOUR_K, file.path);

  const folderWeights = new Map<string, number>();
  for (const { file: neighbour, score } of neighbours) {
    if (score < MIN_NEIGHBOUR_SIMILARITY) continue;
    const parent = neighbour.parent;
    if (!parent || parent.path === "/" || parent.path === file.parent?.path) continue;
    folderWeights.set(parent.path, (folderWeights.get(parent.path) ?? 0) + score);
  }

  const results: Array<{ folder: TFolder; score: number }> = [];
  for (const [folderPath, weight] of folderWeights) {
    const folder = app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) continue;
    const size = folderSize(folder);
    if (size === 0) continue;
    const score = weight / Math.sqrt(size);
    if (score >= MIN_SCORE) results.push({ folder, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 2);
}

