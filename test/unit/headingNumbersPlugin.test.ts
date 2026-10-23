import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";

import { headingNumbersConfig, type HeadingNumbersConfig } from "../../src/headingNumbers";
import { HEADING_NUMBER_ATTR, HEADING_NUMBERED_CLASS, refreshHeadingNumbers } from "../../webview/markdown/headingNumbers";
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

function labels(root: HTMLElement): [string, string | null][] {
  return [...root.querySelectorAll<HTMLElement>(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6")].map(
    (h) => [h.textContent ?? "", h.getAttribute(HEADING_NUMBER_ATTR)],
  );
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
});
