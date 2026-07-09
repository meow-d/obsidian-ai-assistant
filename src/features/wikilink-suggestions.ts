import { App, Menu } from "obsidian";
import { log } from "../core/log";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { extractCandidates, getLinkedPhrases } from "../core/nlp";
import { embed } from "../core/embedder";
import type { VaultIndex, SearchResult } from "../core/vault-index";

const MIN_SCORE = 0.45;
const DEBOUNCE_MS = 20_000;
const INITIAL_DELAY_MS = 1_000;

const setCandidates = StateEffect.define<DecorationSet>();

const candidateField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCandidates)) deco = e.value;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

type CandidateSuggestion = { from: number; to: number; phrase: string; result: SearchResult };
const viewSuggestions = new WeakMap<EditorView, CandidateSuggestion[]>();

async function runCandidateAnalysis(view: EditorView, app: App, index: VaultIndex): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) return;

  const text = view.state.doc.toString();
  const candidates = extractCandidates(text);
  const linked = getLinkedPhrases(text);
  const unlinked = candidates.filter((c) => !linked.has(c.toLowerCase()));

  log(`[wikilink-candidates] file="${file.path}", candidates=${candidates.length}, unlinked=${unlinked.length}`);

  if (unlinked.length === 0) {
    view.dispatch({ effects: setCandidates.of(Decoration.none) });
    viewSuggestions.set(view, []);
    return;
  }

  const embeddings = await embed(unlinked);
  const suggestions: CandidateSuggestion[] = [];

  for (let i = 0; i < unlinked.length; i++) {
    const results = await index.searchByEmbedding(embeddings[i], 1, file.path);
    if (results.length > 0 && results[0].score >= MIN_SCORE) {
      const idx = text.indexOf(unlinked[i]);
      if (idx !== -1) {
        suggestions.push({ from: idx, to: idx + unlinked[i].length, phrase: unlinked[i], result: results[0] });
      }
    }
  }

  log(`[wikilink-candidates] decorating ${suggestions.length} phrases`);
  suggestions.sort((a, b) => a.from - b.from);
  viewSuggestions.set(view, suggestions);

  const decos = suggestions.length
    ? Decoration.set(suggestions.map((s) => Decoration.mark({ class: "fyp-wikilink-candidate" }).range(s.from, s.to)))
    : Decoration.none;
  view.dispatch({ effects: setCandidates.of(decos) });
}

export function createWikilinkCandidateExtension(app: App, index: VaultIndex) {
  const plugin = ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay = DEBOUNCE_MS) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => runCandidateAnalysis(view, app, index), delay);
    };

    schedule(INITIAL_DELAY_MS);

    return {
      update(upd: ViewUpdate) {
        if (upd.docChanged) schedule();
      },
      destroy() {
        if (timer) clearTimeout(timer);
        viewSuggestions.delete(view);
      },
    };
  });

  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("fyp-wikilink-candidate")) return false;

      const suggestions = viewSuggestions.get(view) ?? [];
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      const match = suggestions.find((s) => pos >= s.from && pos <= s.to);
      if (!match) return false;

      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle(`Link to [[${match.result.file.basename}]]`).onClick(() => {
          view.dispatch({
            changes: { from: match.from, to: match.to, insert: `[[${match.result.file.basename}|${match.phrase}]]` },
          });
        })
      );
      menu.addItem((item) =>
        item.setTitle("Dismiss").onClick(() => {
          const remaining = (viewSuggestions.get(view) ?? []).filter((s) => s !== match);
          viewSuggestions.set(view, remaining);
          const decos = remaining.length
            ? Decoration.set(remaining.map((s) => Decoration.mark({ class: "fyp-wikilink-candidate" }).range(s.from, s.to)))
            : Decoration.none;
          view.dispatch({ effects: setCandidates.of(decos) });
        })
      );
      menu.showAtMouseEvent(event);
      return true;
    },
  });

  return [candidateField, plugin, clickHandler];
}
