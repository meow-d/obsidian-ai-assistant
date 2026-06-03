import { setIcon } from "obsidian";

export const SIDEBAR_VIEWS = {
  SIMILAR_NOTES: "fyp-similar-notes",
  AGENT: "fyp-agent",
  SEARCH: "fyp-search",
  ORPHAN_RESCUER: "fyp-orphan-rescuer",
} as const;

const SIDEBAR_LABELS: Record<string, string> = {
  [SIDEBAR_VIEWS.SIMILAR_NOTES]: "Smart Suggestions",
  [SIDEBAR_VIEWS.AGENT]: "AI Agent",
  [SIDEBAR_VIEWS.SEARCH]: "Search",
  [SIDEBAR_VIEWS.ORPHAN_RESCUER]: "Orphan Rescuer",
};

const SIDEBAR_ICONS: Record<string, string> = {
  [SIDEBAR_VIEWS.SIMILAR_NOTES]: "files",
  [SIDEBAR_VIEWS.AGENT]: "bot",
  [SIDEBAR_VIEWS.SEARCH]: "search",
  [SIDEBAR_VIEWS.ORPHAN_RESCUER]: "unlink",
};

export function createSidebarSwitcher(
  container: HTMLElement,
  currentView: string,
  onSwitch: (viewType: string) => void
): void {
  const switcherEl = container.createEl("div", { cls: "fyp-sidebar-switcher" });

  for (const [, viewType] of Object.entries(SIDEBAR_VIEWS)) {
    const button = switcherEl.createEl("button", {
      cls: "fyp-switcher-btn",
      attr: { title: SIDEBAR_LABELS[viewType], "aria-label": SIDEBAR_LABELS[viewType] },
    });
    setIcon(button, SIDEBAR_ICONS[viewType]);

    if (viewType === currentView) {
      button.addClass("active");
    }

    button.addEventListener("click", () => {
      onSwitch(viewType);
    });
  }
}
