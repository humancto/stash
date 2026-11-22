// Keyboard and TV remote navigation.
// - Up/Down move between items of the list the focus is in ([data-rove]).
// - Left/Right move between zones ([data-zone]): rail, main, side panel.
// - "/" focuses search.
// Keys are left alone in text fields, on a focused <video> (arrows seek),
// and in fullscreen.

export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement)
    return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
    return true;
  if (el instanceof HTMLInputElement) {
    return ![
      "button",
      "checkbox",
      "radio",
      "submit",
      "reset",
      "range",
    ].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

const visible = (el: HTMLElement) =>
  el.offsetParent !== null || el.getClientRects().length > 0;

function items(container: ParentNode, selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)].filter(visible);
}

function moveInList(dir: 1 | -1): boolean {
  const active = document.activeElement;
  const list = active?.closest("[data-rove]");
  if (!list || !active) return false;
  const all = items(list, "[data-rove-item]");
  // Focus may be on another control in the same row (a delete button, its
  // confirm): count from that row's item, not from the top of the list.
  // Nearest enclosing row (inside this list) that holds an item.
  let own: HTMLElement | null = null;
  for (let li = active.closest("li"); li && list.contains(li); li = li.parentElement?.closest("li") ?? null) {
    own = li.querySelector<HTMLElement>("[data-rove-item]");
    if (own) break;
  }
  const i = all.indexOf(active as HTMLElement) >= 0
    ? all.indexOf(active as HTMLElement)
    : own
      ? all.indexOf(own)
      : -1;
  const next = all[i < 0 ? 0 : Math.min(all.length - 1, Math.max(0, i + dir))];
  next?.focus();
  return Boolean(next);
}

function moveZone(dir: 1 | -1): boolean {
  const zones = items(document, "[data-zone]");
  // Zones nest (the Watch actions panel sits inside main), so the current
  // zone is the innermost one around the focus, not the first that contains it.
  const here = document.activeElement?.closest<HTMLElement>("[data-zone]") ?? null;
  const current = here ? zones.indexOf(here) : -1;
  const target = zones[current < 0 ? 0 : current + dir];
  if (!target) return false;
  const first =
    target.querySelector<HTMLElement>(
      "[data-rove-item][aria-current='page'], [data-rove-item][aria-selected='true']",
    ) ?? items(target, "[data-rove-item], a[href], button:not([disabled])")[0];
  first?.focus();
  return Boolean(first);
}

export function handleNavKey(e: KeyboardEvent, focusSearch: () => void): void {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.fullscreenElement) return;
  if (isTypingTarget(document.activeElement)) return;
  let handled = false;
  switch (e.key) {
    case "/":
      focusSearch();
      handled = true;
      break;
    case "ArrowDown":
      handled = moveInList(1);
      break;
    case "ArrowUp":
      handled = moveInList(-1);
      break;
    case "ArrowRight":
      handled = moveZone(1);
      break;
    case "ArrowLeft":
      handled = moveZone(-1);
      break;
  }
  if (handled) e.preventDefault();
}
