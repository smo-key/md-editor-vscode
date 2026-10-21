import { beforeAll, describe, expect, it } from "vitest";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

import {
  blockBackspaceCommand,
  disableHeadingDowngrade,
  headingBackspace,
} from "../../webview/markdown/headingBackspace";

// happy-dom lacks the layout APIs ProseMirror's view calls; stub them, as
// toc.test.ts does.
beforeAll(() => {
  const range = globalThis.Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  if (!range.getClientRects) range.getClientRects = () => [];
  if (!range.getBoundingClientRect)
    range.getBoundingClientRect = () => ({}) as DOMRect;
  const el = globalThis.Element.prototype as unknown as {
    getClientRects?: () => DOMRect[];
  };
  if (!el.getClientRects) el.getClientRects = () => [];
});

async function makeEditor(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let ctxRef: Ctx | undefined;
  const editor = await Editor.make()
    .config((ctx) => {
      ctxRef = ctx;
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .config(disableHeadingDowngrade)
    .use(commonmark)
    .use(gfm)
    .use(headingBackspace)
    .create();
  return { editor, ctx: ctxRef! };
}

/** Position of the start of the first text node equal to `text`. */
function findText(doc: ProseNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text === text) found = pos;
    return true;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

/**
 * Empty the block holding `marker` (so the fixture can name it), put the
 * cursor in it, then press Backspace via the command. Returns whether the
 * command handled it and the resulting document.
 */
async function backspaceIn(
  markdown: string,
  marker: string,
  { empty = true, offset = 0 } = {},
) {
  const { editor, ctx } = await makeEditor(markdown);
  const view = ctx.get(editorViewCtx);
  const start = findText(view.state.doc, marker);
  if (empty) {
    const tr = view.state.tr.delete(start, start + marker.length);
    tr.setSelection(TextSelection.create(tr.doc, start));
    view.dispatch(tr);
  } else {
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, start + offset),
      ),
    );
  }
  const handled = blockBackspaceCommand(ctx)(view.state, view.dispatch);
  const doc = view.state.doc;
  const cursor = view.state.selection.$from;
  await editor.destroy();
  return { handled, doc, cursor };
}

/** Top-level block types, e.g. ["bullet_list", "paragraph", "bullet_list"]. */
const shape = (doc: ProseNode) => doc.children.map((n) => n.type.name);

/** Every list item's own text, in document order. */
function items(doc: ProseNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "list_item") {
      out.push(node.firstChild?.textContent ?? "");
    }
    return true;
  });
  return out;
}

describe("Backspace in an empty list item", () => {
  it("turns an empty top-level bullet into a paragraph between the lists", async () => {
    const { handled, doc, cursor } = await backspaceIn("- a\n- X\n- c\n", "X");
    expect(handled).toBe(true);
    expect(shape(doc)).toEqual(["bullet_list", "paragraph", "bullet_list"]);
    expect(doc.child(1).content.size).toBe(0);
    expect(items(doc)).toEqual(["a", "c"]);
    expect(cursor.parent.type.name).toBe("paragraph");
    expect(cursor.depth).toBe(1);
  });

  it("does the same for an empty numbered item", async () => {
    const { handled, doc } = await backspaceIn("1. a\n2. X\n3. c\n", "X");
    expect(handled).toBe(true);
    expect(shape(doc)).toEqual(["ordered_list", "paragraph", "ordered_list"]);
    expect(items(doc)).toEqual(["a", "c"]);
    // The list after the paragraph carries on counting.
    expect(doc.child(2).attrs.order).toBe(2);
  });

  it("keeps a list's own start when its first item is emptied", async () => {
    const { handled, doc } = await backspaceIn("5. X\n6. b\n", "X");
    expect(handled).toBe(true);
    expect(shape(doc)).toEqual(["paragraph", "ordered_list"]);
    expect(doc.child(1).attrs.order).toBe(5);
  });

  it("lifts an empty nested bullet under a numbered item out of every list", async () => {
    const md = "1. a\n   - b\n   - X\n   - d\n2. e\n";
    const { handled, doc, cursor } = await backspaceIn(md, "X");
    expect(handled).toBe(true);
    expect(cursor.depth).toBe(1);
    expect(cursor.parent.type.name).toBe("paragraph");
    // Neighbours stay listed: b still under a; d keeps its bullet list, which
    // can no longer hang off an item above the paragraph; e keeps its number.
    expect(shape(doc)).toEqual([
      "ordered_list",
      "paragraph",
      "bullet_list",
      "ordered_list",
    ]);
    expect(items(doc)).toEqual(["a", "b", "d", "e"]);
    expect(doc.child(3).attrs.order).toBe(2);
  });

  it("turns an empty task item into a plain paragraph", async () => {
    const { handled, doc, cursor } = await backspaceIn(
      "- [ ] a\n- [ ] X\n- [x] c\n",
      "X",
    );
    expect(handled).toBe(true);
    expect(shape(doc)).toEqual(["bullet_list", "paragraph", "bullet_list"]);
    expect(cursor.depth).toBe(1);
  });

  it("leaves a non-empty item to the default behaviour", async () => {
    const { handled, doc } = await backspaceIn("- a\n- b\n", "b", {
      empty: false,
    });
    expect(handled).toBe(false);
    expect(shape(doc)).toEqual(["bullet_list"]);
    expect(items(doc)).toEqual(["a", "b"]);
  });
});

describe("Backspace in a heading", () => {
  it("turns an empty heading into a paragraph", async () => {
    const { handled, doc } = await backspaceIn("Intro\n\n### X\n", "X");
    expect(handled).toBe(true);
    expect(shape(doc)).toEqual(["paragraph", "paragraph"]);
  });

  it("still converts a non-empty heading at offset 0", async () => {
    const { handled, doc } = await backspaceIn("Intro\n\n## Title\n", "Title", {
      empty: false,
    });
    expect(handled).toBe(true);
    expect(shape(doc)).toEqual(["paragraph", "paragraph"]);
    expect(doc.child(1).textContent).toBe("Title");
  });

  it("ignores a cursor past offset 0", async () => {
    const { handled } = await backspaceIn("## Title\n", "Title", {
      empty: false,
      offset: 2,
    });
    expect(handled).toBe(false);
  });
});
