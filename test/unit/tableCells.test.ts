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

describe("header and total rows", () => {
  it("removes the header (an empty one is saved) and restores it", async () => {
    await withEditor("| a | b |\n| - | - |\n| 1 | 2 |\n", (view, out, run) => {
      caretAfter(view, "a");
      run("table-header");
      expect(view.state.doc.firstChild!.firstChild!.type.name).toBe("table_row");
      expect(out()).toBe("<!-- ken:table noheader -->\n|   |   |\n| - | - |\n| a | b |\n| 1 | 2 |\n");
      run("table-header");
      expect(out()).toBe("| a | b |\n| - | - |\n| 1 | 2 |\n");
    });
  });

  it("loads a headerless table without its empty header", async () => {
    await withEditor("<!-- ken:table noheader -->\n|   |   |\n| - | - |\n| a | b |\n| 1 | 2 |\n", (view, out) => {
      const table = view.state.doc.firstChild!;
      expect(table.childCount).toBe(2);
      expect(table.firstChild!.type.name).toBe("table_row");
      expect(out()).toBe("<!-- ken:table noheader -->\n|   |   |\n| - | - |\n| a | b |\n| 1 | 2 |\n");
    });
  });

  it("keeps a header that has text even with the noheader flag", async () => {
    await withEditor("<!-- ken:table noheader -->\n| h |\n| - |\n| a |\n", (view) => {
      expect(view.state.doc.firstChild!.firstChild!.type.name).toBe("table_header_row");
    });
  });

  it("adds a total row with column sums, and marks it", async () => {
    await withEditor("| Item | Cost | Qty |\n| - | - | - |\n| a | $1,200.50 | 2 |\n| b | $3 | x |\n", (view, out, run) => {
      caretAfter(view, "Item");
      run("table-total");
      const md = out();
      expect(md.split("\n")[0]).toBe("<!-- ken:table total -->");
      expect(md).toMatch(/\| Total +\| \$1,203\.50 +\| +\|/);
      run("table-total");
      expect(out()).not.toContain("ken:table");
    });
  });
});
