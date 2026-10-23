// Tab / Shift+Tab inside lists, pressed as real keydown events on the real
// editor: they indent / outdent an item when that is possible and otherwise do
// nothing at all. They never fall through to Crepe's indent plugin, which
// inserts four spaces.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

type Mounted = Awaited<ReturnType<typeof mountEditor>>;

function posAfter(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i + text.length;
    return false;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function caretAfter(view: EditorView, text: string) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posAfter(view, text))));
}

/** Press a key; returns whether the editor claimed it (preventDefault). */
function press(view: EditorView, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string, ed: Mounted) => void | Promise<void>) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const md = () => normalizeTrailingNewlines(ed.markdown());
  try {
    await fn(view, md, ed);
  } finally {
    await ed.destroy();
  }
}

/** A refused Tab must leave no tab characters or trailing spaces behind. */
function expectNoIndentText(view: EditorView, md: string) {
  expect(md).not.toMatch(/\t| +$/m);
  expect(view.state.doc.textContent).not.toMatch(/\t| {2}/);
}

const NESTED = "- one\n  - two\n  - three\n- four\n";

describe("Tab in a list", () => {
  it("does nothing on the first child of a nested list (no previous sibling)", async () => {
    await withEditor(NESTED, (view, md) => {
      const before = md();
      caretAfter(view, "two");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(before);
      expectNoIndentText(view, md());
    });
  });

  it("does nothing on the first item of a top-level list", async () => {
    await withEditor(NESTED, (view, md) => {
      const before = md();
      caretAfter(view, "one");
      expect(press(view, "Tab")).toBe(true);
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(before);
      expectNoIndentText(view, md());
    });
  });

  it("does nothing in an empty first item", async () => {
    await withEditor("- one\n", (view, md) => {
      // An empty first item: "one" deleted.
      const start = posAfter(view, "one");
      view.dispatch(view.state.tr.delete(start - 3, start));
      const before = md();
      expect(view.state.doc.textContent).toBe("");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(before);
      expectNoIndentText(view, md());
    });
  });

  it("still indents an item that has a previous sibling", async () => {
    await withEditor(NESTED, (view, md) => {
      caretAfter(view, "three");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("- one\n  - two\n    - three\n- four\n");
      // A second Tab: "three" is now the first child of its level.
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("- one\n  - two\n    - three\n- four\n");
    });
  });

  it("indents an empty item made with Enter, then stops", async () => {
    await withEditor("- one\n- two\n", (view, md) => {
      caretAfter(view, "two");
      press(view, "Enter");
      expect(press(view, "Tab")).toBe(true);
      const nested = md();
      expect(nested).toMatch(/^- one\n- two\n {2}-/);
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(nested);
      expectNoIndentText(view, md());
    });
  });

  it("does nothing for a selection starting on an item that can't be indented", async () => {
    await withEditor(NESTED, (view, md) => {
      const before = md();
      const sel = TextSelection.create(view.state.doc, posAfter(view, "two") - 2, posAfter(view, "three") - 1);
      view.dispatch(view.state.tr.setSelection(sel));
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(before);
      expectNoIndentText(view, md());
    });
  });

  it("indents a selection spanning several items together", async () => {
    await withEditor("- a\n- b\n- c\n", (view, md) => {
      const sel = TextSelection.create(view.state.doc, posAfter(view, "b") - 1, posAfter(view, "c"));
      view.dispatch(view.state.tr.setSelection(sel));
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("- a\n  - b\n  - c\n");
    });
  });

  it("task lists: refuses on the first item, indents the next", async () => {
    await withEditor("- [ ] a\n- [x] b\n", (view, md) => {
      const before = md();
      caretAfter(view, "a");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(before);
      expectNoIndentText(view, md());
      caretAfter(view, "b");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("- [ ] a\n  - [x] b\n");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("- [ ] a\n  - [x] b\n");
    });
  });

  it("ordered lists: refuses on the first item, indents the next", async () => {
    await withEditor("1. a\n2. b\n", (view, md) => {
      const before = md();
      caretAfter(view, "a");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe(before);
      expectNoIndentText(view, md());
      caretAfter(view, "b");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("1. a\n   - b\n");
      expect(press(view, "Tab")).toBe(true);
      expect(md()).toBe("1. a\n   - b\n");
      expectNoIndentText(view, md());
    });
  });
});

describe("Shift+Tab in a list", () => {
  it("does nothing on a top-level item", async () => {
    await withEditor(NESTED, (view, md) => {
      const before = md();
      for (const text of ["one", "four"]) {
        caretAfter(view, text);
        expect(press(view, "Tab", true)).toBe(true);
        expect(md()).toBe(before);
      }
    });
  });

  it("does nothing on a top-level task or ordered item", async () => {
    for (const doc of ["- [ ] a\n- [ ] b\n", "1. a\n2. b\n"]) {
      await withEditor(doc, (view, md) => {
        const before = md();
        caretAfter(view, "b");
        expect(press(view, "Tab", true)).toBe(true);
        expect(md()).toBe(before);
      });
    }
  });

  it("outdents a nested item", async () => {
    await withEditor(NESTED, (view, md) => {
      caretAfter(view, "three");
      expect(press(view, "Tab", true)).toBe(true);
      expect(md()).toBe("- one\n  - two\n- three\n- four\n");
      expect(press(view, "Tab", true)).toBe(true);
      expect(md()).toBe("- one\n  - two\n- three\n- four\n");
    });
  });
});

describe("Tab in blocks inside a list item keeps their own rule", () => {
  it("a heading in an item changes level", async () => {
    // A list item opens with a paragraph, so the heading is its second block.
    await withEditor("- item\n\n  # Head\n", (view, md) => {
      const level = () => view.state.selection.$from.parent.attrs.level;
      caretAfter(view, "Head");
      expect(press(view, "Tab")).toBe(true);
      expect(level()).toBe(2);
      expect(md()).toBe("- item\n\n  ## Head\n");
      expect(press(view, "Tab", true)).toBe(true);
      expect(press(view, "Tab", true)).toBe(true);
      expect(level()).toBe(1);
      expect(md()).toBe("- item\n\n  # Head\n");
    });
  });

  it("a table in an item moves between cells", async () => {
    const doc = "- item\n\n  | A | B |\n  | - | - |\n  | 1 | 2 |\n";
    await withEditor(doc, (view, md) => {
      const before = md();
      caretAfter(view, "A");
      expect(press(view, "Tab")).toBe(true);
      expect(view.state.selection.$from.parent.textContent).toBe("B");
      expect(md()).toBe(before);
    });
  });
});

describe("Tab outside lists is unchanged", () => {
  it("still reaches the rest of the keymap in a plain paragraph", async () => {
    await withEditor("text\n", (view) => {
      caretAfter(view, "text");
      // Crepe's indent plugin answers it, as before.
      expect(press(view, "Tab")).toBe(true);
    });
  });
});
