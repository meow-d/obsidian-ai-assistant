export function normalizePath(p: string): string { return p; }

export function getAllTags(cache: any): string[] | null {
  const inline: string[] = (cache?.tags ?? []).map((t: any) => t.tag);
  const fmTags = cache?.frontmatter?.tags;
  const frontmatter: string[] = Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : [];
  const all = [...inline, ...frontmatter.map((t) => (t.startsWith("#") ? t : `#${t}`))];
  return all.length > 0 ? Array.from(new Set(all)) : null;
}

export class TFile {
  path: string = "";
  basename: string = "";
  extension: string = "md";
  stat = { mtime: 0, ctime: 0, size: 0 };
  parent = null;
}

export class TFolder {
  path: string = "";
  children: unknown[] = [];
  parent = null;
}

export class App {}
export class ItemView {
  containerEl = { children: [null, { createEl: () => ({ createEl: () => ({}), addEventListener: () => {}, addClass: () => {} }), addClass: () => {} }] };
  leaf: unknown = null;
  constructor(leaf: unknown) { this.leaf = leaf; }
  registerEvent() {}
}
export class WorkspaceLeaf {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addSlider() { return this; }
  addDropdown() { return this; }
}
export class Notice {
  constructor(_msg: string) {}
}
export class Modal {}
export class Menu {}
