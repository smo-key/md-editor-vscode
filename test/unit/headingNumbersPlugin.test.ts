import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";

import { headingNumbersConfig, type HeadingNumbersConfig } from "../../src/headingNumbers";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { HEADING_NUMBER_ATTR, HEADING_NUMBERED_CLASS, headingNumberDecorations, refreshHeadingNumbers } from "../../webview/markdown/headingNumbers";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

const DOC = [
  "# Intro",
  "",
  "## Background",
  "",
  "#### Skipped a level",
  "",
  "### Details",
  "",
  "> ## Quoted heading",
  "",
  "- item",
  "",
  "  ## Listed heading",
  "",
  "| a |",
  "| - |",
  "| b |",
  "",
  "# Next",
  "",
  "##### Five",
  "",
  "###### Six",
  "",
].join("\n");

let mounted: Awaited<ReturnType<typeof mountEditor>> | undefined;
afterEach(async () => {
  await mounted?.destroy();
  mounted = undefined;
});

async function mount(markdown: string, config: () => HeadingNumbersConfig | undefined) {
  mounted = await mountEditor(markdown, { headingNumbers: config });
  return mounted;
}

const on = headingNumbersConfig({ enabled: true });

/** A heading's own text, without the copy-link button. */
function headingText(h: Element): string {
  const clone = h.cloneNode(true) as Element;
  clone.querySelectorAll(".ProseMirror-widget, [contenteditable=false]").forEach((w) => w.remove());
  return clone.textContent ?? "";
}

/** Each heading's text and the label shown before it (null: none). */
function labels(root: HTMLElement): [string, string | null][] {
  return [...root.querySelectorAll<HTMLElement>(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6")].map(
    (h) => [headingText(h), h.getAttribute(HEADING_NUMBER_ATTR)],
  );
}

const viewOf = (editor: Awaited<ReturnType<typeof mountEditor>>) => editor.crepe.editor.ctx.get(editorViewCtx);

/** Runs a key through the editor's handlers, as a keydown would. */
function press(view: EditorView, key: string): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  view.someProp("handleKeyDown", (f) => f(view, event));
}

describe("heading numbers plugin", () => {
  it("numbers top-level headings only, omitting skipped levels", async () => {
    const { root } = await mount(DOC, () => on);
    expect(labels(root)).toEqual([
      ["Intro", "1"],
      ["Background", "1.a"],
      ["Skipped a level", "1.a.1"],
      ["Details", "1.a.i"],
      ["Quoted heading", null],
      ["Listed heading", null],
      ["Next", "2"],
      ["Five", "2.a"],
      ["Six", "2.a.i"],
    ]);
    const numbered = root.querySelector(".ProseMirror h1");
    expect(numbered?.classList.contains(HEADING_NUMBERED_CLASS)).toBe(true);
  });

  it("shows nothing when disabled or unconfigured", async () => {
    const { root } = await mount(DOC, () => undefined);
    expect(root.querySelectorAll(`[${HEADING_NUMBER_ATTR}]`)).toHaveLength(0);
    expect(root.querySelectorAll(`.${HEADING_NUMBERED_CLASS}`)).toHaveLength(0);
  });

  it("never writes numbers to the Markdown", async () => {
    const editor = await mount("# One\n\n## Two\n", () => on);
    expect(editor.markdown()).toBe("# One\n\n## Two\n");
    expect(editor.markdown()).not.toContain("1.a");
  });

  it("follows a live config change", async () => {
    let config: HeadingNumbersConfig = headingNumbersConfig({ enabled: false });
    const editor = await mount("# One\n\n## Two\n", () => config);
    const view = editor.crepe.editor.ctx.get(editorViewCtx);
    expect(labels(editor.root).map(([, n]) => n)).toEqual([null, null]);

    config = on;
    refreshHeadingNumbers(view);
    expect(labels(editor.root).map(([, n]) => n)).toEqual(["1", "1.a"]);

    config = headingNumbersConfig({ enabled: true, styles: ["upper-roman", "decimal"], separator: "-" });
    refreshHeadingNumbers(view);
    expect(labels(editor.root).map(([, n]) => n)).toEqual(["I", "I-1"]);

    config = headingNumbersConfig({ enabled: false });
    refreshHeadingNumbers(view);
    expect(labels(editor.root).map(([, n]) => n)).toEqual([null, null]);
  });

  it("renumbers as headings are edited", async () => {
    const editor = await mount("# One\n\n## Two\n", () => on);
    const view = editor.crepe.editor.ctx.get(editorViewCtx);
    const { schema } = view.state;
    const h2 = schema.nodes.heading!.create({ level: 2 }, schema.text("Zero"));
    // Before "## Two": after the h1.
    const afterFirst = view.state.doc.firstChild!.nodeSize;
    view.dispatch(view.state.tr.insert(afterFirst, h2));
    expect(labels(editor.root)).toEqual([
      ["One", "1"],
      ["Zero", "1.a"],
      ["Two", "1.b"],
    ]);
  });

  it("numbers the table of contents to match", async () => {
    const md = ["# Title", "", "<!-- ken:toc -->", "- [A](#a)", "", "## A", "", "### B", "", "> ## Quoted", "", "## C", ""].join("\n");
    const { root } = await mount(md, () => on);
    await new Promise((r) => setTimeout(r, 0));
    const items = [...root.querySelectorAll<HTMLElement>("ul.ken-toc li p")].map((p) => [p.textContent, p.getAttribute(HEADING_NUMBER_ATTR)]);
    expect(items).toEqual([
      ["A", "1.a"],
      ["B", "1.a.i"],
      ["Quoted", null],
      ["C", "1.b"],
    ]);
  });

  it("adds no DOM node or text to the heading: the stylesheet draws the label", async () => {
    const { root } = await mount("# One\n", () => on);
    const h1 = root.querySelector(".ProseMirror h1")!;
    expect(h1.getAttribute(HEADING_NUMBER_ATTR)).toBe("1");
    expect(h1.textContent).toBe("One");
    expect([...h1.children].every((c) => c.classList.contains("ken-heading-link"))).toBe(true);
  });

  it("keeps the heading DOM while you type elsewhere, and its label while you type in it", async () => {
    const editor = await mount("# One\n\n## Two\n\nBody\n", () => on);
    const view = viewOf(editor);
    const before = [...editor.root.querySelectorAll(".ProseMirror h1, .ProseMirror h2")];
    view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1));
    const after = [...editor.root.querySelectorAll(".ProseMirror h1, .ProseMirror h2")];
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    view.dispatch(view.state.tr.insertText("x", 1));
    view.dispatch(view.state.tr.insertText("y", view.state.doc.firstChild!.nodeSize + 1));
    expect(labels(editor.root)).toEqual([
      ["xOne", "1"],
      ["yTwo", "1.a"],
    ]);
  });

  it("leaves the caret at the heading's text start, never inside the label", async () => {
    const editor = await mount("# One\n", () => on);
    const view = viewOf(editor);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    // Position 1 maps to the heading's own text: nothing precedes it but the
    // (absolutely placed) copy-link button.
    const { node, offset } = view.domAtPos(1);
    const range = document.createRange();
    range.setStart(view.nodeDOM(0)!, 0);
    range.setEnd(node, offset);
    expect(range.toString()).toBe("");
    expect(view.state.selection.from).toBe(1);
    view.dispatch(view.state.tr.insertText("Z"));
    expect(editor.markdown()).toBe("# ZOne\n");
  });

  it("Backspace at the heading start does what it does without numbers", async () => {
    const md = "Intro\n\n## Two\n";
    const run = async (config: () => HeadingNumbersConfig | undefined) => {
      const editor = await mount(md, config);
      const view = viewOf(editor);
      const start = view.state.doc.firstChild!.nodeSize + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      press(view, "Backspace");
      const out = { markdown: editor.markdown(), from: view.state.selection.from };
      press(view, "Backspace");
      const twice = { markdown: editor.markdown(), from: view.state.selection.from };
      await editor.destroy();
      mounted = undefined;
      return [out, twice];
    };
    const plain = await run(() => undefined);
    const numbered = await run(() => on);
    expect(numbered).toEqual(plain);
  });

  it("never copies the label", async () => {
    const editor = await mount("# One\n\n## Two\n\nBody\n", () => on);
    const view = viewOf(editor);
    const { doc } = view.state;
    const slice = doc.slice(0, doc.content.size);
    const { dom, text } = view.serializeForClipboard(slice);
    expect(text).not.toMatch(/\b1\.a\b/);
    expect(text).toContain("One");
    expect(dom.querySelector(`[${HEADING_NUMBER_ATTR}]`)).toBeNull();
    expect(dom.textContent).not.toContain("1.a");
  });

  it("keeps the same decoration set while typing in a paragraph", async () => {
    const editor = await mount("# One\n\nBody\n\n## Two\n\nTail\n", () => on);
    const view = viewOf(editor);
    const set = headingNumberDecorations(view.state);
    expect(set?.find()).toHaveLength(2);
    // After every heading: nothing labelled moves.
    view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1));
    expect(headingNumberDecorations(view.state)).toBe(set);
    // A no-op step (as the frontmatter history makes) changes nothing either.
    view.dispatch(view.state.tr.replaceWith(1, 1, []));
    expect(headingNumberDecorations(view.state)).toBe(set);
    // Before a heading: the same labels, mapped, not rebuilt from scratch.
    const bodyEnd = view.state.doc.firstChild!.nodeSize + 5;
    view.dispatch(view.state.tr.insertText("?", bodyEnd));
    const mapped = headingNumberDecorations(view.state)!;
    expect(mapped.find().map((d) => [d.from, d.to])).toEqual(
      set!.find().map((d, i) => (i === 0 ? [d.from, d.to] : [d.from + 1, d.to + 1])),
    );
    expect(labels(editor.root).map(([, n]) => n)).toEqual(["1", "1.a"]);
    // A new heading renumbers.
    view.dispatch(view.state.tr.setBlockType(view.state.doc.firstChild!.nodeSize + 1, view.state.doc.firstChild!.nodeSize + 1, view.state.schema.nodes.heading!, { level: 2 }));
    expect(headingNumberDecorations(view.state)).not.toBe(mapped);
    expect(labels(editor.root).map(([, n]) => n)).toEqual(["1", "1.a", "1.b"]);
  });
});
