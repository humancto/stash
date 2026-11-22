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

function moveInList(dir: 1 | -1, leaveList = false): boolean {
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
  // From a grid's edge row, go straight to the neighbouring list.
  const j = leaveList ? (dir === 1 ? all.length : -1) : i < 0 ? 0 : i + dir;
  if (j < 0 || j >= all.length) {
    // Past the end of this list: continue into the next list in the same
    // zone (a toolbar above a list, shelves on a page).
    const zone = list.closest("[data-zone]");
    if (zone) {
      const lists = items(zone, "[data-rove]").filter(
        (l) => l.closest("[data-zone]") === zone && items(l, "[data-rove-item]").length > 0,
      );
      const here = lists.indexOf(list as HTMLElement);
      const other = here < 0 ? undefined : lists[here + dir];
      if (other) {
        const its = items(other, "[data-rove-item]");
        const target = other.matches('[data-rove="grid"]')
          ? nearestInRow(its, active as HTMLElement, dir)
          : dir === 1
            ? its[0]
            : its[its.length - 1];
        target?.focus();
        target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        return Boolean(target);
      }
    }
    // Nowhere to go: keep focus, still consume the key.
    return all.length > 0;
  }
  const next = all[j];
  next?.focus();
  return Boolean(next);
}

const rectOf = (el: HTMLElement) => (el.closest("li") ?? el).getBoundingClientRect();

/** Entering a grid from above (dir 1) or below (-1): the item in its
 * first/last row closest horizontally to where focus was. */
function nearestInRow(its: HTMLElement[], from: HTMLElement, dir: 1 | -1): HTMLElement | undefined {
  if (its.length === 0) return undefined;
  const a = rectOf(from);
  const ax = a.left + a.width / 2;
  const rects = its.map(rectOf);
  const edge = dir === 1 ? Math.min(...rects.map((r) => r.top)) : Math.max(...rects.map((r) => r.top));
  let best: HTMLElement | undefined;
  let bestD = Infinity;
  rects.forEach((r, i) => {
    if (Math.abs(r.top - edge) > r.height / 2) return;
    const d = Math.abs(r.left + r.width / 2 - ax);
    if (d < bestD) {
      bestD = d;
      best = its[i];
    }
  });
  return best ?? (dir === 1 ? its[0] : its[its.length - 1]);
}

export type Dir = "left" | "right" | "up" | "down";

/** Rectangles of a 2-D grid's items in DOM order → the index to move to,
 * or null at the edge. Left/Right stay in the row; Up/Down pick the item
 * in the nearest row above/below whose centre is closest horizontally. */
export function nextInGrid(
  rects: readonly { left: number; top: number; width: number; height: number }[],
  from: number,
  dir: Dir,
): number | null {
  const a = rects[from];
  if (!a) return null;
  const cx = (r: (typeof rects)[number]) => r.left + r.width / 2;
  const cy = (r: (typeof rects)[number]) => r.top + r.height / 2;
  const sameRow = (r: (typeof rects)[number]) => Math.abs(cy(r) - cy(a)) < a.height / 2;
  let best: number | null = null;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    if (i === from) return;
    let score: number;
    if (dir === "left" || dir === "right") {
      if (!sameRow(r)) return;
      const dx = cx(r) - cx(a);
      if (dir === "left" ? dx >= 0 : dx <= 0) return;
      score = Math.abs(dx);
    } else {
      const dy = cy(r) - cy(a);
      if (sameRow(r) || (dir === "up" ? dy >= 0 : dy <= 0)) return;
      // Nearest row first, then nearest column.
      score = Math.abs(dy) * 10_000 + Math.abs(cx(r) - cx(a));
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** Arrow keys inside `[data-rove="grid"]`. Returns true when handled; at
 * an edge it returns false so the caller falls back (zones for Left/Right,
 * the next list for Up/Down). */
function moveInGrid(dir: Dir): boolean | "edge" {
  const active = document.activeElement as HTMLElement | null;
  const grid = active?.closest<HTMLElement>('[data-rove="grid"]');
  if (!grid || !active) return false;
  const all = items(grid, "[data-rove-item]");
  const from = all.indexOf(active);
  if (from < 0) return false;
  // Measure the list item (the containment root under content-visibility),
  // not the link inside it, so a key press doesn't force layout of
  // off-screen posters.
  const next = nextInGrid(all.map(rectOf), from, dir);
  if (next === null) return "edge";
  const el = all[next];
  el?.focus();
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
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
    case "ArrowUp":
    case "ArrowRight":
    case "ArrowLeft": {
      const dir = ({ ArrowDown: "down", ArrowUp: "up", ArrowRight: "right", ArrowLeft: "left" } as const)[e.key];
      const g = moveInGrid(dir);
      if (g === true) {
        handled = true;
        break;
      }
      // Not in a grid, or at its edge: the usual list / zone moves.
      if (dir === "down") handled = moveInList(1, g === "edge");
      else if (dir === "up") handled = moveInList(-1, g === "edge");
      else {
        handled = moveZone(dir === "right" ? 1 : -1);
        // The end of a shelf: keep focus rather than let the page scroll.
        if (!handled && g === "edge") handled = true;
      }
      break;
    }
  }
  if (handled) e.preventDefault();
}
