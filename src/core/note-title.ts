import { App, TFile } from "obsidian";

/** Resolves a note's display title: frontmatter title, then alias, then first H1, then filename. */
export function getDisplayTitle(app: App, file: TFile, enabled: boolean): string {
  if (!enabled) return file.basename;

  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (typeof fm?.title === "string" && fm.title.trim()) return fm.title;

  const aliases = fm?.aliases;
  const firstAlias = Array.isArray(aliases) ? aliases[0] : aliases;
  if (typeof firstAlias === "string" && firstAlias.trim()) return firstAlias;

  const h1 = app.metadataCache.getFileCache(file)?.headings?.find((h) => h.level === 1);
  if (h1?.heading) return h1.heading;

  return file.basename;
}
