// Placement of pasted/dropped files (webview/fileDrop.ts) on the real editor,
// and what it writes to Markdown.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { carriesFiles, droppedUris, insertAttachments, type Attachment } from "../../webview/fileDrop";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

const img = (href: string): Attachment => ({ href, name: href, image: true });
const file = (href: string, name = href): Attachment => ({ href, name, image: false });

/** Insert at the position after `after` (or at doc position `at`) and return the Markdown. */
async function insertInto(markdown: string, where: { after?: string; atEndOf?: string }, items: Attachment[]) {
  const ed = await mountEditor(markdown);
  const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const target = where.after ?? where.atEndOf!;
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos >= 0 || !node.isText) return pos < 0;
    const i = node.text!.indexOf(target);
    if (i >= 0) pos = p + i + target.length;
    return false;
  });
  if (where.after === "") pos = 1;
  if (pos < 0) throw new Error(`no text ${target}`);
  view.dispatch(insertAttachments(view.state.tr, pos, items));
  const out = normalizeTrailingNewlines(ed.markdown());
  const caret = view.state.selection;
  await ed.destroy();
  return { out, caretEmpty: caret.empty };
}

describe("insertAttachments", () => {
  it("links a file inline at the caret, spaced from the words around it", async () => {
    const { out } = await insertInto("See the spec here.\n", { after: "See the" }, [file("Spec%20v2.pdf", "Spec v2.pdf")]);
    expect(out).toBe("See the [Spec v2.pdf](Spec%20v2.pdf) spec here.\n");
  });

  it("adds a space before a link glued to a word", async () => {
    const { out } = await insertInto("Attached:\n", { after: "Attached:" }, [file("a.txt")]);
    expect(out).toBe("Attached: [a.txt](a.txt)\n");
  });

  it("links several files inline, space separated", async () => {
    const { out } = await insertInto("Files: here\n", { after: "Files: " }, [file("a.txt"), file("b.csv")]);
    expect(out).toBe("Files: [a.txt](a.txt) [b.csv](b.csv) here\n");
  });

  it("puts an image after the paragraph instead of splitting it", async () => {
    const { out } = await insertInto("First paragraph here.\n\nNext.\n", { after: "First para" }, [img("shot.png")]);
    expect(out).toBe("First paragraph here.\n\n![](shot.png)\n\nNext.\n");
  });

  it("puts an image before the paragraph when dropped at its start", async () => {
    const ed = await mountEditor("Para.\n");
    const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    view.dispatch(insertAttachments(view.state.tr, 1, [img("a.png")]));
    expect(normalizeTrailingNewlines(ed.markdown())).toBe("![](a.png)\n\nPara.\n");
    await ed.destroy();
  });

  it("replaces an empty line with the image, leaving no blank-line debris", async () => {
    const ed = await mountEditor("Above.\n");
    const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    const end = view.state.doc.content.size;
    // An empty paragraph, as after pressing Enter.
    const tr = view.state.tr.insert(end, view.state.schema.nodes.paragraph.create());
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)));
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create(null, view.state.schema.text("Below."))));
    view.dispatch(insertAttachments(view.state.tr, end + 1, [img("a.png")]));
    const out = normalizeTrailingNewlines(ed.markdown());
    expect(out).toBe("Above.\n\n![](a.png)\n\nBelow.\n");
    expect(out).not.toContain("<br");
    await ed.destroy();
  });

  it("mixes images and files as blocks after the paragraph", async () => {
    const { out } = await insertInto("Text.\n", { after: "Te" }, [file("notes.txt"), img("photo.jpg")]);
    expect(out).toBe("Text.\n\n[notes.txt](notes.txt)\n\n![](photo.jpg)\n");
  });

  it("keeps images inline in table cells", async () => {
    const { out } = await insertInto("| a | b |\n| - | - |\n| x | y |\n", { after: "x" }, [img("i.png")]);
    expect(out).toContain("| x ![](i.png) | y |");
  });

  it("links files inside list items without breaking the item", async () => {
    const { out } = await insertInto("- item one\n- item two\n", { after: "item one" }, [file("f.pdf")]);
    expect(out).toBe("- item one [f.pdf](f.pdf)\n- item two\n");
  });

  it("leaves the caret after what was inserted", async () => {
    const { caretEmpty } = await insertInto("x\n", { after: "x" }, [file("a.txt")]);
    expect(caretEmpty).toBe(true);
  });
});

function transfer(data: Record<string, string>, files = false): DataTransfer {
  return {
    types: [...Object.keys(data), ...(files ? ["Files"] : [])],
    getData: (t: string) => data[t] ?? "",
    files: { length: files ? 1 : 0 },
  } as unknown as DataTransfer;
}

describe("dropped URIs", () => {
  it("reads VS Code's uri-list, ResourceURLs and CodeFiles", () => {
    expect(droppedUris(transfer({ "text/uri-list": "# comment\r\nfile:///w/a.png\r\nhttps://x.dev\r\n" }))).toEqual([
      "file:///w/a.png",
    ]);
    expect(droppedUris(transfer({ resourceurls: '["file:///w/b.md"]' }))).toEqual(["file:///w/b.md"]);
    expect(droppedUris(transfer({ codefiles: '["/w/My File.md"]' }))).toEqual(["file:///w/My%20File.md"]);
    expect(droppedUris(transfer({ "text/plain": "hello" }))).toEqual([]);
  });

  it("knows which drags carry files", () => {
    expect(carriesFiles(transfer({}, true))).toBe(true);
    expect(carriesFiles(transfer({ "text/uri-list": "file:///a" }))).toBe(true);
    expect(carriesFiles(transfer({ "text/plain": "x" }))).toBe(false);
  });
});
