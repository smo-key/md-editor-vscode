// The body's bytes as read from the file come back exactly when the editor
// says the same thing again (webview/bodyBaseline.ts): after undoing every
// edit, after an outside change, and when only the comment threads changed.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { BodyBaseline } from "../../webview/bodyBaseline";
import { addCommentRange, removeCommentRange } from "../../webview/comments/anchors";
import { formatThreads, replaceThreads, splitThreads, threadStore, type CommentThread } from "../../webview/comments/store";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

// Syntax the serializer normalizes when it rewrites the body.
const BODY = [
  "Title",
  "=====",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "* one",
  "* two",
  "",
  "Text.",
  "",
].join("\n");

const thread = (id: string, ...texts: string[]): CommentThread => ({
  id,
  resolved: false,
  messages: texts.map((text, i) => ({ id: `m${i + 1}`, author: "Ana", date: "", text })),
});

/** The editor on `raw` (a body with its threads block), with main.ts's way of writing it. */
async function setup(raw: string) {
  const { body: markdown, block } = splitThreads(raw);
  const editor = await mountEditor(markdown);
  const view = editor.crepe.editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
  const serialize = () => normalizeTrailingNewlines(editor.markdown());
  const baseline = new BodyBaseline();
  baseline.open(view.state.doc, serialize(), block, raw);
  const write = (back = block) =>
    baseline.body(view.state.doc, back, serialize, (md) => md + (back ? `${md ? "\n" : ""}${back}` : ""));
  const type = (text: string) =>
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).insertText(text));
  const undoAll = () => {
    while (undo(view.state, view.dispatch));
  };
  return { editor, view, baseline, write, type, undoAll, serialize };
}

describe("the body after undoing every edit", () => {
  it("is the file's own bytes again", async () => {
    const { editor, write, type, undoAll } = await setup(BODY);
    // Sanity: the serializer would normalize it.
    expect(normalizeTrailingNewlines(editor.markdown())).not.toBe(BODY);
    type("!");
    const edited = write();
    expect(edited).toContain("Text.!");
    expect(edited).not.toBe(BODY);
    undoAll();
    expect(write()).toBe(BODY);
    await editor.destroy();
  });

  it("keeps the threads block with it", async () => {
    const block = formatThreads([thread("c1", "Hi")]);
    const raw = BODY.replace("Text.", "<!-- ken:comment c1 -->Text.<!-- /ken:comment c1 -->") + "\n\n" + block;
    const { editor, write, type, undoAll } = await setup(raw);
    type("!");
    expect(write()).not.toBe(raw);
    undoAll();
    expect(write()).toBe(raw);
    await editor.destroy();
  });
});

describe("a change to the comment threads only", () => {
  it("swaps the threads block and leaves the body's bytes alone", async () => {
    const block = formatThreads([thread("c1", "Hi")]);
    const text = BODY.replace("Text.", "<!-- ken:comment c1 -->Text.<!-- /ken:comment c1 -->");
    const raw = text + "\n\n" + block;
    const { editor, write } = await setup(raw);
    const reply = formatThreads([thread("c1", "Hi", "Hello back")]);
    expect(write(reply)).toBe(text + "\n\n" + reply);
    // And back.
    expect(write(block)).toBe(raw);
    await editor.destroy();
  });

  it("swaps it in after the opened bytes once an undo returns to them", async () => {
    const block = formatThreads([thread("c1", "Hi")]);
    const text = BODY.replace("Text.", "<!-- ken:comment c1 -->Text.<!-- /ken:comment c1 -->");
    const { editor, write, type, undoAll } = await setup(text + "\n" + block);
    type("!");
    write();
    undoAll();
    const reply = formatThreads([thread("c1", "Hi", "Hello back")]);
    expect(write(reply)).toBe(text + "\n" + reply);
    await editor.destroy();
  });

  it("writes markers a new thread adds, and the original bytes once it is removed", async () => {
    const { editor, view, write } = await setup(BODY);
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text!.includes("Text.")) at = pos + node.text!.indexOf("Text.");
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + 5)));
    view.dispatch(addCommentRange(view.state, "c9")!);
    const block = formatThreads([thread("c9", "New")]);
    const added = write(block);
    expect(added).toContain("<!-- ken:comment c9 -->");
    expect(added).toContain("Text.<!-- /ken:comment c9 -->");
    expect(added.endsWith(block)).toBe(true);
    view.dispatch(removeCommentRange(view.state, "c9")!);
    expect(write("")).toBe(BODY);
    await editor.destroy();
  });
});

describe("a new comment", () => {
  it("writes its markers once its first message turns the draft into a thread", async () => {
    const { editor, view, write } = await setup(BODY);
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text!.includes("Text.")) at = pos + node.text!.indexOf("Text.") + 1;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + 3)));
    threadStore.create("d1");
    try {
      view.dispatch(addCommentRange(view.state, "d1")!);
      // A draft (no message yet) is not written: the markers are left out.
      const draft = write("");
      expect(draft).not.toContain("ken:comment");
      // Sent: the same document, now with a thread in the block.
      threadStore.reply("d1", "First");
      const back = threadStore.format(["d1"]);
      const sent = write(back);
      expect(sent).toContain("<!-- ken:comment d1 -->");
      expect(sent).toContain("<!-- /ken:comment d1 -->");
      expect(sent.endsWith(back)).toBe(true);
    } finally {
      threadStore.remove("d1");
    }
    await editor.destroy();
  });
});

describe("a change from outside", () => {
  it("becomes the bytes an undo returns to", async () => {
    const { editor, view, baseline, write, type, undoAll, serialize } = await setup(BODY);
    // The file changed in the source editor: the editor follows (not undoable).
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.atEnd(view.state.doc))
        .insertText("Other ", view.state.doc.content.size - 6)
        .setMeta("addToHistory", false),
    );
    expect(view.state.doc.textContent).toContain("Other Text.");
    const reloaded = BODY.replace("Text.", "Other Text.");
    baseline.reload(view.state.doc, serialize(), "", reloaded);
    expect(write()).toBe(reloaded);
    type("!");
    expect(write()).not.toBe(reloaded);
    undoAll();
    // The outside change stays: the reloaded bytes, never the opened ones.
    expect(write()).toBe(reloaded);
    await editor.destroy();
  });

  it("is forgotten along with the opened bytes", async () => {
    const { editor, baseline, write, type, undoAll } = await setup(BODY);
    baseline.forget();
    type("!");
    write();
    undoAll();
    expect(write()).not.toBe(BODY);
    await editor.destroy();
  });
});

describe("replaceThreads", () => {
  const block = formatThreads([thread("c1", "Hi")]);
  const other = formatThreads([thread("c2", "Yo")]);
  it("replaces, adds and removes the block, keeping the text before it", () => {
    expect(replaceThreads(`Text.\n\n${block}`, other)).toBe(`Text.\n\n${other}`);
    expect(replaceThreads(`Text.\n${block}`, other)).toBe(`Text.\n${other}`);
    expect(replaceThreads("Text.\n", other)).toBe(`Text.\n\n${other}`);
    expect(replaceThreads("Text.", other)).toBe(`Text.\n\n${other}`);
    expect(replaceThreads(`Text.\n\n${block}`, "")).toBe("Text.\n");
    expect(replaceThreads(block, other)).toBe(other);
    expect(replaceThreads("", other)).toBe(other);
  });
});
