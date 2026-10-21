import { beforeAll, describe, expect, it } from "vitest";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { callCommand, getMarkdown } from "@milkdown/kit/utils";
import { TextSelection } from "@milkdown/kit/prose/state";

import {
  TABLE_FULL_WIDTH_COMMENT,
  isTableFullWidthComment,
  tableFullWidthPlugins,
  toggleTableFullWidthCommand,
} from "../../webview/markdown/tableFullWidth";

// happy-dom does not implement the layout APIs ProseMirror's view layer calls
// while rendering; stub the few we need so the editor can mount headlessly.
beforeAll(() => {
  const proto = globalThis.Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  const emptyRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  if (!proto.getClientRects) proto.getClientRects = () => [];
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect;
  const el = globalThis.Element.prototype as unknown as {
    getClientRects?: () => DOMRect[];
  };
  if (!el.getClientRects) el.getClientRects = () => [];
});

async function makeEditor(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(tableFullWidthPlugins)
    .create();
}

async function roundTrip(markdown: string): Promise<string> {
  const editor = await makeEditor(markdown);
  const out = editor.action(getMarkdown());
  await editor.destroy();
  return out;
}

const TABLE = ["| a | b |", "| - | - |", "| 1 | 2 |", ""].join("\n");
const FULL = `${TABLE_FULL_WIDTH_COMMENT}\n${TABLE}`;

describe("isTableFullWidthComment", () => {
  it("matches the canonical marker", () => {
    expect(isTableFullWidthComment(TABLE_FULL_WIDTH_COMMENT)).toBe(true);
  });

  it("tolerates extra whitespace", () => {
    expect(isTableFullWidthComment("<!--ken:table   full-->")).toBe(true);
    expect(isTableFullWidthComment("<!--  ken:table full  -->")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isTableFullWidthComment("<!-- ken:table -->")).toBe(false);
    expect(isTableFullWidthComment("<!-- ken:table wide -->")).toBe(false);
    expect(isTableFullWidthComment("<!-- a comment -->")).toBe(false);
    expect(isTableFullWidthComment(undefined)).toBe(false);
  });
});

describe("full width tables", () => {
  it("leaves a plain table alone", async () => {
    expect(await roundTrip(TABLE)).toBe(TABLE);
  });

  it("round trips a marked table", async () => {
    const out = await roundTrip(FULL);
    expect(out).toBe(FULL);
    expect(await roundTrip(out)).toBe(FULL);
  });

  it("sets the attribute on the table node, not a stray html node", async () => {
    const editor = await makeEditor(FULL);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("table");
    expect(doc.child(0).attrs.fullWidth).toBe(true);
    await editor.destroy();
  });

  it("defaults to false without the marker", async () => {
    const editor = await makeEditor(TABLE);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.child(0).attrs.fullWidth).toBe(false);
    await editor.destroy();
  });

  it("leaves a comment that is not followed by a table alone", async () => {
    const md = `${TABLE_FULL_WIDTH_COMMENT}\n\nJust a paragraph.\n`;
    const editor = await makeEditor(md);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.child(0).type.name).not.toBe("table");
    expect(editor.action(getMarkdown())).toContain("ken:table full");
    await editor.destroy();
  });

  // remark-stringify pads cells to the alignment markers, so the expected
  // output is its normalized form; the second round trip proves it is stable.
  it("keeps column alignment while carrying the flag", async () => {
    const md = [
      TABLE_FULL_WIDTH_COMMENT,
      "| a | b | c |",
      "| :- | :-: | -: |",
      "| 1 | 2 | 3 |",
      "",
    ].join("\n");
    const expected = [
      TABLE_FULL_WIDTH_COMMENT,
      "| a  |  b  |  c |",
      "| :- | :-: | -: |",
      "| 1  |  2  |  3 |",
      "",
    ].join("\n");
    const out = await roundTrip(md);
    expect(out).toBe(expected);
    expect(await roundTrip(out)).toBe(expected);
  });

  it("toggles the flag on and off", async () => {
    const editor = await makeEditor(TABLE);
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Put the selection inside the first header cell.
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(3)),
        ),
      );
    });
    editor.action(callCommand(toggleTableFullWidthCommand.key, undefined));
    expect(editor.action(getMarkdown())).toBe(FULL);
    editor.action(callCommand(toggleTableFullWidthCommand.key, undefined));
    expect(editor.action(getMarkdown())).toBe(TABLE);
    await editor.destroy();
  });

  it("marks only the table that carried the comment", async () => {
    const md = `${TABLE}\n${FULL}`;
    const editor = await makeEditor(md);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).attrs.fullWidth).toBe(false);
    expect(doc.child(1).attrs.fullWidth).toBe(true);
    await editor.destroy();
  });
});
