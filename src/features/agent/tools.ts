import { App, TFile } from "obsidian";
import type { ToolHandlers } from "../../core/llm";
import type { VaultIndex } from "../../core/vault-index";

export function makeToolHandlers(index: VaultIndex, app: App): ToolHandlers {
  return {
    search_vault: async (query: string, limit = 5): Promise<string> => {
      const clamped = Math.max(1, Math.min(10, limit));
      const results = await index.search(query, clamped);
      if (results.length === 0) return "No notes found matching that query.";
      return results
        .map((r) => `**${r.file.basename}** (${r.file.path})\n${r.preview}`)
        .join("\n\n");
    },
    read_note: async (path: string): Promise<string> => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return `Note not found: ${path}`;
      const content = await app.vault.cachedRead(file);
      return `# ${file.basename}\n\n${content}`;
    },
    get_linked_notes: async (path: string): Promise<string> => {
      const neighbours = index.getOneHopNeighbours(path);
      if (neighbours.length === 0) return "No linked notes found.";
      return neighbours.map((p) => `- ${p}`).join("\n");
    },
    edit_note: async (path: string, content: string): Promise<string> => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return `Note not found: ${path}`;
      await app.vault.modify(file, content);
      return `Note "${file.basename}" updated successfully.`;
    },
    create_note: async (path: string, content: string): Promise<string> => {
      if (app.vault.getAbstractFileByPath(path)) return `Note already exists: ${path}`;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
      if (dir && !app.vault.getAbstractFileByPath(dir)) {
        await app.vault.createFolder(dir);
      }
      await app.vault.create(path, content);
      return `Note created at "${path}".`;
    },
    delete_note: async (path: string): Promise<string> => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return `Note not found: ${path}`;
      await app.vault.delete(file);
      return `Note "${file.basename}" deleted.`;
    },
  };
}
