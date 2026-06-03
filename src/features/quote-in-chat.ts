import { AGENT_VIEW, AgentView } from "./agent";
import type FypPlugin from "../main";

export function registerQuoteInChat(plugin: FypPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu, editor) => {
      const selection = editor.getSelection();
      if (!selection) return;

      menu.addItem((item) => {
        item.setTitle("Quote in agent chat").setIcon("quote-glyph").onClick(async () => {
          plugin.activateViewFromSwitcher(AGENT_VIEW);
          const leaves = plugin.app.workspace.getLeavesOfType(AGENT_VIEW);
          if (leaves.length === 0) return;
          const view = leaves[0].view as AgentView;
          view.appendToInput(`> ${selection.replace(/\n/g, "\n> ")}\n`);
        });
      });
    })
  );
}
