import { beforeAll, describe, expect, it } from "vitest";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown } from "@milkdown/kit/utils";

import { collectHeadings } from "../../webview/markdown/anchors";
import {
  HEADING_LINK_CLASS,
  headingLinkMarkdown,
  headingLinkPlugin,
} from "../../webview/markdown/headingLink";

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

const DOC = ["# Getting Started", "", "Body.", "", "## What's new?", ""].join(
  "\n",
);

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
    .use(headingLinkPlugin)
    .create();
}

describe("headingLinkMarkdown", () => {
  it("writes a markdown link to the slug", () => {
    expect(headingLinkMarkdown("Getting Started", "getting-started")).toBe(
      "[Getting Started](#getting-started)",
    );
  });
});

describe("heading link widget", () => {
  it("renders one button per heading, carrying its slug", async () => {
    const editor = await makeEditor(DOC);
    const dom = editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const buttons = [...dom.querySelectorAll(`.${HEADING_LINK_CLASS}`)];
    expect(buttons.length).toBe(2);
    expect(buttons.map((b) => b.getAttribute("data-slug"))).toEqual([
      "getting-started",
      "whats-new",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("contenteditable")).toBe("false");
    }
    await editor.destroy();
  });

  it("never reaches the serialized markdown", async () => {
    const editor = await makeEditor(DOC);
    expect(editor.action(getMarkdown())).toBe(DOC);
    await editor.destroy();
  });

  it("matches the slugs the anchor resolver computes", async () => {
    const editor = await makeEditor(DOC);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(collectHeadings(doc).map((h) => h.slug)).toEqual([
      "getting-started",
      "whats-new",
    ]);
    await editor.destroy();
  });
});
