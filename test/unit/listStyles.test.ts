import { beforeAll, describe, expect, it } from "vitest";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getMarkdown } from "@milkdown/kit/utils";

import {
  configureListDelimiter,
  letterValue,
  liftListItemCommand,
  listStylePlugins,
  orderedLabel,
  sinkListItemCommand,
  toAlpha,
  toRoman,
} from "../../webview/markdown/listStyles";

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

describe("labels", () => {
  it("counts in letters past z as spreadsheets do", () => {
    expect([1, 2, 26, 27, 52, 53].map(toAlpha)).toEqual([
      "a",
      "b",
      "z",
      "aa",
      "az",
      "ba",
    ]);
  });

  it("writes lowercase roman numerals", () => {
    expect([1, 4, 9, 14, 40, 1994].map(toRoman)).toEqual([
      "i",
      "iv",
      "ix",
      "xiv",
      "xl",
      "mcmxciv",
    ]);
  });

  it("styles by numbered-list depth: number, letter, roman, and round again", () => {
    expect(orderedLabel(2, 1)).toBe("2.");
    expect(orderedLabel(2, 2)).toBe("b.");
    expect(orderedLabel(2, 3)).toBe("ii.");
    expect(orderedLabel(2, 4)).toBe("2.");
    expect(orderedLabel(3, 2, ")")).toBe("c)");
  });

  it("maps a typed letter to its number", () => {
    expect(letterValue("a")).toBe(1);
    expect(letterValue("C")).toBe(3);
  });
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
      // House style, as MarkdownEditor.svelte configures it.
      ctx.update(remarkStringifyOptionsCtx, (opts) => ({
        ...opts,
        bullet: "-" as const,
      }));
    })
    .config(configureListDelimiter)
    .use(commonmark)
    .use(gfm)
    .use(listStylePlugins)
    .create();
  // The label plugin corrects the parsed labels from a microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ctx = ctxRef!;
  return { editor, ctx, view: ctx.get(editorViewCtx) };
}

async function roundTrip(markdown: string): Promise<string> {
  const { editor } = await makeEditor(markdown);
  const out = editor.action(getMarkdown());
  await editor.destroy();
  return out;
}

/** Every list item's label, in document order, with its text. */
function labels(doc: ProseNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "list_item") {
      const text = node.firstChild?.textContent ?? "";
      const mark =
        node.attrs.listType === "bullet" ? "•" : String(node.attrs.label);
      out.push(`${mark} ${text}`);
    }
    return true;
  });
  return out;
}

function cursorAtEndOf(view: EditorView, text: string) {
  let target = -1;
  view.state.doc.descendants((node, pos) => {
    if (target < 0 && node.isText && node.text === text) {
      target = pos + node.nodeSize;
    }
    return target < 0;
  });
  if (target < 0) throw new Error(`no text ${text}`);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, target)),
  );
}

/** Type `text` at the cursor the way the browser does, input rules included. */
function typeText(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

const NESTED = [
  "1. one",
  "",
  "   1. sub a",
  "   2. sub b",
  "",
  "      1. deep i",
  "",
  "2. two",
  "",
].join("\n");

describe("markdown round trip", () => {
  it("keeps nested numbered lists as plain `1.` lists", async () => {
    expect(await roundTrip(NESTED)).toBe(NESTED);
  });

  it("keeps a `)` list's delimiter, nested or not", async () => {
    const md = ["1) one", "", "   1) sub", "", "2) two", ""].join("\n");
    expect(await roundTrip(md)).toBe(md);
  });

  it("keeps a lettered level's start", async () => {
    const md = ["1. one", "", "   3. sub c", "   4. sub d", ""].join("\n");
    expect(await roundTrip(md)).toBe(md);
  });

  it("leaves bullets under numbers alone", async () => {
    const md = ["1. one", "", "   - bullet", "", "     - deeper", ""].join(
      "\n",
    );
    expect(await roundTrip(md)).toBe(md);
  });

  it("leaves `a. ` lines in a file as paragraphs", async () => {
    const md = "a. not a list\n";
    expect(await roundTrip(md)).toBe(md);
  });
});

describe("labels in the editor", () => {
  it("letters the second numbered level and romans the third", async () => {
    const { editor, view } = await makeEditor(NESTED);
    expect(labels(view.state.doc)).toEqual([
      "1. one",
      "a. sub a",
      "b. sub b",
      "i. deep i",
      "2. two",
    ]);
    await editor.destroy();
  });

  it("counts a lettered level from its start, with its delimiter", async () => {
    const { editor, view } = await makeEditor(
      ["1) one", "", "   3) sub c", "   4) sub d", ""].join("\n"),
    );
    expect(labels(view.state.doc)).toEqual(["1) one", "c) sub c", "d) sub d"]);
    await editor.destroy();
  });

  it("keeps bullets between numbered levels out of the count", async () => {
    const md = ["1. one", "", "   - bullet", "", "     1. under", ""].join(
      "\n",
    );
    const { editor, view } = await makeEditor(md);
    expect(labels(view.state.doc)).toEqual(["1. one", "• bullet", "a. under"]);
    await editor.destroy();
  });

  it("relabels after an edit", async () => {
    const { editor, view } = await makeEditor(NESTED);
    cursorAtEndOf(view, "sub a");
    // Enter: split the item, so "sub b" becomes the third letter.
    const { from } = view.state.selection;
    const item = view.state.schema.nodes.list_item!;
    view.dispatch(view.state.tr.split(from, 2, [{ type: item }]));
    expect(labels(view.state.doc).slice(1, 4)).toEqual([
      "a. sub a",
      "b. ",
      "c. sub b",
    ]);
    await editor.destroy();
  });
});

describe("Tab and Shift-Tab", () => {
  it("starts a bulleted sub-level under a numbered item", async () => {
    const { editor, ctx, view } = await makeEditor("1. one\n2. two\n");
    cursorAtEndOf(view, "two");
    expect(sinkListItemCommand(ctx)(view.state, view.dispatch)).toBe(true);
    expect(labels(view.state.doc)).toEqual(["1. one", "• two"]);
    expect(editor.action(getMarkdown())).toBe(
      "1. one\n\n   - two\n",
    );
    await editor.destroy();
  });

  it("joins an existing lettered level rather than starting a new one", async () => {
    const md = ["1. one", "", "   1. sub a", "", "2. two", ""].join("\n");
    const { editor, ctx, view } = await makeEditor(md);
    cursorAtEndOf(view, "two");
    sinkListItemCommand(ctx)(view.state, view.dispatch);
    expect(labels(view.state.doc)).toEqual(["1. one", "a. sub a", "b. two"]);
    await editor.destroy();
  });

  it("lifts a bullet back into the numbered list", async () => {
    const { editor, ctx, view } = await makeEditor(
      "1. one\n\n   - two\n",
    );
    cursorAtEndOf(view, "two");
    expect(liftListItemCommand(ctx)(view.state, view.dispatch)).toBe(true);
    expect(labels(view.state.doc)).toEqual(["1. one", "2. two"]);
    await editor.destroy();
  });
});

describe("typing a list marker", () => {
  const EMPTY_SUB = "1. one\n   - x\n";

  async function typeIntoEmptySub(typed: string, text = "sub") {
    const { editor, view } = await makeEditor(EMPTY_SUB);
    // Empty the nested item, then type into it.
    cursorAtEndOf(view, "x");
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.delete(from - 1, from));
    typeText(view, typed + text);
    const doc = view.state.doc;
    const md = editor.action(getMarkdown());
    await editor.destroy();
    return { doc, md };
  }

  it("`a. ` turns a nested bullet level into a lettered one", async () => {
    const { doc, md } = await typeIntoEmptySub("a. ");
    expect(labels(doc)).toEqual(["1. one", "a. sub"]);
    expect(md).toBe("1. one\n\n   1. sub\n");
  });

  it("`a) ` does the same with a parenthesis", async () => {
    const { doc, md } = await typeIntoEmptySub("a) ");
    expect(labels(doc)).toEqual(["1. one", "a) sub"]);
    expect(md).toBe("1. one\n\n   1) sub\n");
  });

  it("`c. ` starts the lettered level at c", async () => {
    const { doc, md } = await typeIntoEmptySub("c. ");
    expect(labels(doc)).toEqual(["1. one", "c. sub"]);
    expect(md).toBe("1. one\n\n   3. sub\n");
  });

  it("`a. ` partway down a bullet level starts a lettered list there", async () => {
    const { editor, view } = await makeEditor("1. one\n   - bullet\n   - x\n");
    cursorAtEndOf(view, "x");
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.delete(from - 1, from));
    typeText(view, "a. sub");
    expect(labels(view.state.doc)).toEqual(["1. one", "• bullet", "a. sub"]);
    expect(editor.action(getMarkdown())).toBe(
      "1. one\n\n   - bullet\n\n   1. sub\n",
    );
    await editor.destroy();
  });

  it("`a. ` at the top level stays text", async () => {
    const { editor, view } = await makeEditor("Intro\n");
    cursorAtEndOf(view, "Intro");
    view.dispatch(view.state.tr.split(view.state.selection.from));
    typeText(view, "a. not a list");
    expect(editor.action(getMarkdown())).toBe("Intro\n\na. not a list\n");
    await editor.destroy();
  });

  it("`1) ` starts a numbered list with a parenthesis", async () => {
    const { editor, view } = await makeEditor("Intro\n");
    cursorAtEndOf(view, "Intro");
    view.dispatch(view.state.tr.split(view.state.selection.from));
    typeText(view, "1) first");
    expect(editor.action(getMarkdown())).toBe("Intro\n\n1) first\n");
    expect(labels(view.state.doc)).toEqual(["1) first"]);
    await editor.destroy();
  });

});
