// Removed (red) content in an editable editor is selectable but not editable:
// the guard in webview/diffDom.ts keeps keys, typing, cut and paste from the
// editor while the selection is in it.
import { afterEach, describe, expect, it } from "vitest";

import { guardReadOnlyIslands, selectionInReadOnlyIsland } from "../../webview/diffDom";

function page() {
  document.body.innerHTML = `
    <div class="ProseMirror" contenteditable="true">
      <p id="text">Kept text</p>
      <div class="ken-diff-widget" contenteditable="false"><p id="removed">Removed text</p></div>
    </div>
    <div class="ken-diff-widget"><p id="outside">Not in an editor</p></div>`;
  const select = (id: string) => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById(id)!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  };
  return select;
}

describe("read-only islands", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("knows when the selection is in removed content inside an editable editor", () => {
    const select = page();
    select("removed");
    expect(selectionInReadOnlyIsland()).toBe(true);
    select("text");
    expect(selectionInReadOnlyIsland()).toBe(false);
    select("outside");
    expect(selectionInReadOnlyIsland()).toBe(false);
  });

  it("keeps editing keys from the editor there, but not copy or selection keys", () => {
    guardReadOnlyIslands();
    const select = page();
    const editor = document.querySelector<HTMLElement>(".ProseMirror")!;
    const seen: string[] = [];
    editor.addEventListener("keydown", (e) => seen.push(e.key));
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      editor.dispatchEvent(e);
      return e.defaultPrevented;
    };
    select("removed");
    expect(press("Backspace")).toBe(true);
    expect(press("a")).toBe(true);
    expect(press("c", { metaKey: true })).toBe(false);
    expect(press("ArrowLeft", { shiftKey: true })).toBe(false);
    expect(seen).toEqual([]);
    // Escape still reaches the editor (and whatever closes on it).
    press("Escape");
    expect(seen).toEqual(["Escape"]);
    select("text");
    expect(press("Backspace")).toBe(false);
    expect(seen).toEqual(["Escape", "Backspace"]);
  });
});
