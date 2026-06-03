import { App, TFile } from "obsidian";
import { embed } from "../../core/embedder";
import type { VaultIndex } from "../../core/vault-index";

const RAG_TOP_K = 5;

export async function buildRagContext(query: string, app: App, index: VaultIndex): Promise<string> {
  const parts: string[] = [];

  const activeFile = app.workspace.getActiveFile();
  if (activeFile instanceof TFile) {
    const content = await app.vault.cachedRead(activeFile);
    parts.push(`## Current note: ${activeFile.path}\n\n${content.slice(0, 1200)}`);
  }

  const openPaths = app.workspace.getLeavesOfType("markdown")
    .map((leaf) => (leaf.view as { file?: TFile }).file?.path)
    .filter((p): p is string => !!p && p !== activeFile?.path);
  if (openPaths.length > 0) {
    parts.push(`## Open tabs\n\n${openPaths.map((p) => `- ${p}`).join("\n")}`);
  }

  const [queryEmb] = await embed([query]);
  const results = await index.searchByEmbedding(queryEmb, RAG_TOP_K);
  if (results.length > 0) {
    const similarParts: string[] = [];
    for (const r of results) {
      const content = await app.vault.cachedRead(r.file);
      const preview = content.slice(0, 600);
      const neighbours = index.getOneHopNeighbours(r.file.path);
      const linkedStr = neighbours.length > 0
        ? `\n*Linked: ${neighbours.map((p) => p.split("/").pop()?.replace(".md", "")).slice(0, 5).join(", ")}*`
        : "";
      similarParts.push(`**${r.file.basename}** (score: ${r.score.toFixed(2)})\n${preview}${linkedStr}`);
    }
    parts.push(`## Similar notes\n\n${similarParts.join("\n\n")}`);
  }

  return parts.join("\n\n");
}
