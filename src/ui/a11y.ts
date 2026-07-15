export function makeActivatable(el: HTMLElement, onActivate: (e: MouseEvent | KeyboardEvent) => void): void {
  el.tabIndex = 0;
  if (!el.getAttribute("role")) el.setAttribute("role", "button");
  el.addEventListener("click", onActivate);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(e);
    }
  });
}
