import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNavKey } from "./keys";

function press(key: string) {
  const e = new KeyboardEvent("keydown", { key, cancelable: true });
  handleNavKey(e, () => document.getElementById("search")?.focus());
  return e;
}

describe("keyboard navigation", () => {
  beforeEach(() => {
    // jsdom has no layout; treat every element as visible.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    document.body.innerHTML = `
      <input id="search" />
      <nav data-zone data-rove>
        <a href="/files" data-rove-item aria-current="page" id="r1">Files</a>
        <a href="/transfers" data-rove-item id="r2">Transfers</a>
      </nav>
      <main data-zone>
        <a href="/files" id="back">Files</a>
        <aside data-zone data-rove>
          <button data-rove-item id="a1">Play</button>
          <button data-rove-item id="a2">Download</button>
        </aside>
      </main>`;
  });
  afterEach(() => vi.restoreAllMocks());

  const focus = (id: string) => document.getElementById(id)?.focus();
  const active = () => document.activeElement?.id;

  it("moves within a list with Up/Down", () => {
    focus("r1");
    press("ArrowDown");
    expect(active()).toBe("r2");
    press("ArrowUp");
    expect(active()).toBe("r1");
  });

  it("treats the innermost zone as current when zones nest", () => {
    focus("a2");
    press("ArrowLeft"); // aside -> main, not rail
    expect(active()).toBe("back");
    focus("a1");
    press("ArrowRight"); // nothing after aside
    expect(active()).toBe("a1");
    focus("back");
    press("ArrowLeft"); // main -> rail, lands on the current page link
    expect(active()).toBe("r1");
  });

  it("leaves text fields alone and handles /", () => {
    focus("search");
    expect(press("ArrowDown").defaultPrevented).toBe(false);
    focus("r1");
    expect(press("/").defaultPrevented).toBe(true);
    expect(active()).toBe("search");
  });
});
