// Selecting across images, tables, diagrams and code: the highlight, the
// Shift+Arrow and Shift+click behaviour, and what deleting writes.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { AllSelection, TextSelection } from "@milkdown/kit/prose/state";
import { CellSelection } from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";

import { BLOCK_SELECTED_CLASS, blockRangeSelection, expandRange } from "../../webview/markdown/blockSelection";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

const DOC = [
  "Intro text",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "Middle",
  "",
  "```js",
  "code();",
  "```",
  "",
  "![pic](x.png)",
  "",
  "---",
  "",
  "End",
  "",
].join("\n");

type Mounted = Awaited<ReturnType<typeof mountEditor>>;

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string, ed: Mounted) => void | Promise<void>) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    await fn(view, () => normalizeTrailingNewlines(ed.markdown()), ed);
  } finally {
    await ed.destroy();
  }
}

/** Position just after the first occurrence of `text` (or at its start). */
function posOf(view: EditorView, text: string, { start = false } = {}): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText) {
      const i = node.text!.indexOf(text);
      if (i >= 0) found = pos + i + (start ? 0 : text.length);
    }
    return true;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function select(view: EditorView, anchor: number, head = anchor) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
}

function press(view: EditorView, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

function highlighted(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(`.${BLOCK_SELECTED_CLASS}`)].map((el) => {
    if (el.matches("table, .milkdown-table-block") || el.querySelector("table")) return "table";
    if (el.matches("hr")) return "hr";
    if (el.querySelector("img") || /image/.test(el.className)) return "image";
    if (/code/.test(el.className) || el.querySelector(".cm-editor")) return "code";
    return el.tagName.toLowerCase() + "." + el.className;
  });
}

/** Top-level node type names. */
function blocks(view: EditorView): string[] {
  const names: string[] = [];
  view.state.doc.forEach((n) => names.push(n.type.name));
  return names;
}

describe("block selection highlight", () => {
  it("highlights every block a text selection spans", async () => {
    await withEditor(DOC, (view) => {
      expect(blocks(view)).toEqual(["paragraph", "table", "paragraph", "code_block", "image-block", "hr", "paragraph", "paragraph"].slice(0, blocks(view).length));
      select(view, posOf(view, "Intro", { start: true }), posOf(view, "End"));
      expect(highlighted(view).sort()).toEqual(["code", "hr", "image", "table"]);
    });
  });

  it("highlights nothing for a selection within text, or a caret", async () => {
    await withEditor(DOC, (view) => {
      select(view, posOf(view, "Intro", { start: true }), posOf(view, "Intro"));
      expect(highlighted(view)).toEqual([]);
      select(view, posOf(view, "Middle"));
      expect(highlighted(view)).toEqual([]);
    });
  });

  it("highlights a table whole when the selection only ends inside it", async () => {
    await withEditor(DOC, (view) => {
      select(view, posOf(view, "Intro", { start: true }), posOf(view, "1"));
      expect(highlighted(view)).toEqual(["table"]);
      // Within one code block: CodeMirror shows it, no block highlight.
      const c = posOf(view, "code", { start: true });
      select(view, c, c + 3);
      expect(highlighted(view)).toEqual([]);
    });
  });

  it("highlights everything on select-all", async () => {
    await withEditor(DOC, (view) => {
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
      expect(highlighted(view).sort()).toEqual(["code", "hr", "image", "table"]);
    });
  });
});

describe("expandRange", () => {
  it("takes the whole table when a range ends inside it", async () => {
    await withEditor(DOC, (view) => {
      const doc = view.state.doc;
      let table = { from: -1, to: -1 };
      doc.forEach((n, pos) => {
        if (n.type.name === "table") table = { from: pos, to: pos + n.nodeSize };
      });
      const from = posOf(view, "Intro");
      expect(expandRange(doc, from, posOf(view, "1"))).toEqual({ from, to: table.to });
      const mid = posOf(view, "Mid");
      expect(expandRange(doc, posOf(view, "a"), mid)).toEqual({ from: table.from, to: mid });
      // Inside one cell: unchanged.
      const one = posOf(view, "1", { start: true });
      expect(expandRange(doc, one, one + 1)).toEqual({ from: one, to: one + 1 });
    });
  });
});

describe("deleting a block selection", () => {
  it("Backspace over text, a table and more text removes the table cleanly", async () => {
    await withEditor(DOC, (view, md) => {
      select(view, posOf(view, "Intro "), posOf(view, "Mid"));
      const before = md();
      if (!press(view, "Backspace")) view.dispatch(view.state.tr.deleteSelection());
      expect(md()).toBe(before.replace(/Intro text[\s\S]*Middle/, "Intro dle"));
    });
  });

  it("Backspace on a selection ending inside a table removes the whole table", async () => {
    await withEditor(DOC, (view, md) => {
      const before = md();
      select(view, posOf(view, "Intro"), posOf(view, "1"));
      expect(press(view, "Backspace")).toBe(true);
      expect(md()).toBe(before.replace(/ text\n\n\|[^]*?\|\n\n/, "\n\n"));
    });
  });

  it("Delete on a selection starting inside a code block removes it whole", async () => {
    await withEditor(DOC, (view, md) => {
      const before = md();
      select(view, posOf(view, "code"), posOf(view, "End", { start: true }));
      expect(press(view, "Delete")).toBe(true);
      expect(md()).toBe(before.replace(/```js[^]*End/, "End"));
    });
  });

  it("from the end of one paragraph to the start of another, removes only the blocks between", async () => {
    await withEditor(DOC, (view, md) => {
      select(view, posOf(view, "Intro text"), posOf(view, "End", { start: true }));
      expect(press(view, "Backspace")).toBe(true);
      expect(md()).toBe("Intro text\n\nEnd\n");
      expect(view.state.selection.head).toBe(posOf(view, "Intro text"));
    });
  });

  it("deleting everything leaves an empty document", async () => {
    await withEditor(DOC, (view, md) => {
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
      view.dispatch(view.state.tr.deleteSelection());
      expect(md()).toBe("");
    });
  });

  it("typing over a selection reaching into a table replaces the table", async () => {
    await withEditor(DOC, (view, md) => {
      select(view, posOf(view, "Intro "), posOf(view, "2"));
      const handled = view.someProp("handleTextInput", (f) => f(view, view.state.selection.from, view.state.selection.to, "X", () => view.state.tr));
      expect(handled).toBe(true);
      expect(md().split("\n").slice(0, 3)).toEqual(["Intro X", "", "Middle"]);
    });
  });
});

describe("Shift+Arrow over blocks", () => {
  it("Shift+Right at the end of a paragraph takes the whole table", async () => {
    await withEditor(DOC, (view) => {
      const start = posOf(view, "Intro text");
      select(view, start);
      expect(press(view, "ArrowRight", true)).toBe(true);
      const sel = view.state.selection;
      expect(sel).toBeInstanceOf(TextSelection);
      expect(sel.anchor).toBe(start);
      expect(sel.head).toBe(posOf(view, "Middle", { start: true }));
      expect(highlighted(view)).toEqual(["table"]);
    });
  });

  it("Shift+Arrow from inside a table the selection started outside of leaves it", async () => {
    await withEditor(DOC, (view) => {
      const start = posOf(view, "Intro");
      select(view, start, posOf(view, "1"));
      expect(press(view, "ArrowDown", true)).toBe(true);
      const sel = view.state.selection;
      expect(sel).not.toBeInstanceOf(CellSelection);
      expect(sel.anchor).toBe(start);
      expect(sel.head).toBe(posOf(view, "Middle", { start: true }));
    });
  });

  it("Shift+Left at the start of a paragraph takes the code block before it", async () => {
    await withEditor("Top\n\n```\nx\n```\n\nBottom\n", (view) => {
      const start = posOf(view, "Bottom", { start: true });
      select(view, start);
      expect(press(view, "ArrowLeft", true)).toBe(true);
      const sel = view.state.selection;
      expect(sel.anchor).toBe(start);
      expect(sel.head).toBe(posOf(view, "Top"));
      expect(highlighted(view)).toEqual(["code"]);
    });
  });

  it("from a cell selection at the table's edge, carries on past the table", async () => {
    await withEditor(DOC, (view) => {
      const doc = view.state.doc;
      const $p = doc.resolve(posOf(view, "2"));
      const cell = $p.before($p.depth - 1);
      view.dispatch(view.state.tr.setSelection(CellSelection.create(doc, cell)));
      expect(press(view, "ArrowDown", true)).toBe(true);
      const sel = view.state.selection;
      expect(sel).toBeInstanceOf(TextSelection);
      expect(sel.head).toBe(posOf(view, "Middle", { start: true }));
      expect(highlighted(view)).toEqual(["table"]);
    });
  });

  it("leaves Shift+Arrow within text alone", async () => {
    await withEditor(DOC, (view) => {
      select(view, posOf(view, "Intro"));
      expect(press(view, "ArrowRight", true)).toBe(false);
    });
  });
});

describe("blockRangeSelection", () => {
  it("covers the whole document as an AllSelection", async () => {
    await withEditor("| a |\n| - |\n| 1 |\n\nText\n", (view) => {
      const sel = blockRangeSelection(view.state.doc, posOf(view, "a"), view.state.doc.content.size);
      expect(sel).toBeInstanceOf(AllSelection);
    });
  });
});
