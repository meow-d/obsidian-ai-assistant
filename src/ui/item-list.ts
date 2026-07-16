import { makeActivatable } from "./a11y";

/**
 * Renders one clickable/keyboard-activatable row per item into an already-created
 * list container. Shared by every sidebar panel that lists notes/conversations
 * (similar notes, resurfacing, agent history) so the create-row/make-activatable
 * boilerplate lives in one place.
 */
export function renderItemList<T>(
  listContainer: HTMLElement,
  itemClass: string,
  items: T[],
  build: (el: HTMLElement, item: T) => void,
  onActivate: (item: T) => void,
): void {
  for (const item of items) {
    const el = listContainer.createEl("div", { cls: itemClass });
    build(el, item);
    makeActivatable(el, () => onActivate(item));
  }
}
