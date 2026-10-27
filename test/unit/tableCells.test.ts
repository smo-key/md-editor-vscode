// Paragraphs, line breaks and lists inside table cells: written as `<br>` and
// inline HTML lists (what GitHub renders), edited as real blocks.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { command, execute } from "../../webview/commands";
import { cellBlocks } from "../../webview/markdown/tableCellBlocks";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

function caretAfter(view: EditorView, text: string) {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i + text.length;
    return false;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string, run: (id: string) => void) => void) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const run = (id: string) => ed.crepe.editor.action((ctx) => execute(ctx, command(id)));
  try {
    fn(view, () => normalizeTrailingNewlines(ed.markdown()), run);
  } finally {
    await ed.destroy();
  }
}

const row = (md: string) => md.split("\n")[2];

describe("blocks in table cells", () => {
  it("round-trips line breaks, paragraphs and nested lists", async () => {
    const md =
      "| a | b |\n| - | - |\n| x<br>y<br><br>**z** | <ul><li>one<ul><li>n</li></ul></li><li>[x] two</li><li>[ ] three</li></ul> |\n| <ol><li>a</li></ol>after | |\n";
    await withEditor(md, (view, out) => {
      const cell = view.state.doc.firstChild!.child(1).child(1);
      expect(cell.firstChild!.type.name).toBe("bullet_list");
      expect(cell.firstChild!.child(1).attrs.checked).toBe(true);
      expect(out()).toContain("| x<br>y<br><br>**z**");
      expect(out()).toContain("<ul><li>one<ul><li>n</li></ul></li><li>[x] two</li><li>[ ] three</li></ul>");
      expect(out()).toContain("| <ol><li>a</li></ol>after");
    });
  });

  it("leaves HTML that doesn't nest as a list alone", () => {
    expect(cellBlocks([{ type: "html", value: "<li>" }, { type: "text", value: "x" }])).toBeNull();
    expect(cellBlocks([{ type: "text", value: "plain" }])).toBeNull();
  });

  it("Shift+Enter and Alt+Enter start a new line in the cell", async () => {
    await withEditor("| a | b |\n| - | - |\n| one | two |\n", (view, out) => {
      caretAfter(view, "one");
      press(view, "Enter", { shiftKey: true });
      view.dispatch(view.state.tr.insertText("more"));
      caretAfter(view, "two");
      press(view, "Enter", { altKey: true });
      view.dispatch(view.state.tr.insertText("again"));
      expect(row(out())).toMatch(/^\| one<br>more +\| two<br>again +\|$/);
    });
  });

  it("list commands work in a cell, and Enter and Tab work the list", async () => {
    await withEditor("| a | b |\n| - | - |\n| one | two |\n", (view, out, run) => {
      caretAfter(view, "one");
      run("bullet-list");
      press(view, "Enter");
      view.dispatch(view.state.tr.insertText("sub"));
      press(view, "Tab");
      expect(row(out())).toContain("<ul><li>one<ul><li>sub</li></ul></li></ul>");
      caretAfter(view, "two");
      run("task-list");
      expect(row(out())).toContain("<ul><li>[ ] two</li></ul>");
    });
  });
});
