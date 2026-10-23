// A key pressed before the browser's selectionchange arrives (a click, then
// a key in the same moment) must act at the caret the user sees.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";

import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

describe("selection sync on keydown", () => {
  it("reads a DOM caret ProseMirror hasn't picked up yet before handling the key", async () => {
    const ed = await mountEditor("First line\n\nSecond line\n");
    try {
      const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      // The browser moves the caret (a click) while its selectionchange is
      // still queued: ProseMirror doesn't see it yet.
      const observer = (view as unknown as { domObserver: { stop(): void; start(): void } }).domObserver;
      const text = [...view.dom.querySelectorAll("p")].find((p) => p.textContent === "Second line")!.firstChild!;
      observer.stop();
      document.getSelection()!.collapse(text, 6);
      observer.start();
      expect(view.state.selection.from).toBe(3);
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
      view.someProp("handleKeyDown", (f) => f(view, event));
      expect(view.state.selection.from).toBe(view.posAtDOM(text, 6));
    } finally {
      await ed.destroy();
    }
  });
});
