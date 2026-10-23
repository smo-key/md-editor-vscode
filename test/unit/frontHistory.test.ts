// Frontmatter edits share the editor's undo history with body edits
// (webview/frontHistory.ts), so undo and redo follow the order edits were made.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { redo, undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { FRONT_GROUP_MS, frontHistory, historyFront, recordFront, resetFront, type FrontState } from "../../webview/frontHistory";
import { BodyBaseline } from "../../webview/bodyBaseline";
import { joinDocument, setProperty } from "../../webview/frontmatterModel";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

const FRONT = "---\ntitle: A\n---\n";

/** An editor with the frontmatter history, standing in for main.ts: `front` is what the panel shows. */
async function setup(markdown = "Hello") {
  const editor = await mountEditor(markdown);
  const view = editor.crepe.editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
  const app = { front: FRONT, gap: "\n", restored: [] as FrontState[] };
  view.updateState(
    view.state.reconfigure({
      plugins: [
        ...view.state.plugins,
        frontHistory((s) => {
          app.front = s.front;
          app.gap = s.gap;
          app.restored.push(s);
        }),
      ],
    }),
  );
  resetFront(view, { front: app.front, gap: app.gap });
  const type = (text: string) => {
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).insertText(text));
  };
  let clock = 1_000_000;
  const editFront = (next: string, gap = app.gap, pause = FRONT_GROUP_MS * 2) => {
    clock += pause;
    app.front = next;
    app.gap = gap;
    recordFront(view, { front: next, gap }, clock);
  };
  const text = () => view.state.doc.textContent;
  return { editor, view, app, type, editFront, text };
}

describe("frontmatter in the undo history", () => {
  it("undoes and redoes body and frontmatter edits in the order they were made", async () => {
    const { editor, view, app, type, editFront, text } = await setup();
    type(" world");
    const edited = setProperty(FRONT, "ken-heading-numbering", "1.a");
    editFront(edited);
    expect(app.restored).toEqual([]);

    // The frontmatter edit was last: it goes first.
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(app.front).toBe(FRONT);
    expect(text()).toBe("Hello world");

    // Then the typing.
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(text()).toBe("Hello");
    expect(app.front).toBe(FRONT);

    // Redo replays them in order.
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(text()).toBe("Hello world");
    expect(app.front).toBe(FRONT);
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(app.front).toBe(edited);
    await editor.destroy();
  });

  it("undoes a body edit made after a frontmatter edit first", async () => {
    const { editor, view, app, type, editFront, text } = await setup();
    const edited = setProperty(FRONT, "tags", "x");
    editFront(edited);
    type("!");
    undo(view.state, view.dispatch);
    expect(text()).toBe("Hello");
    expect(app.front).toBe(edited);
    undo(view.state, view.dispatch);
    expect(app.front).toBe(FRONT);
    await editor.destroy();
  });

  it("groups typing in a property into one undo, split by a pause", async () => {
    const { editor, view, app, editFront } = await setup();
    editFront("---\ntitle: Ab\n---\n");
    editFront("---\ntitle: Abc\n---\n", app.gap, 50);
    editFront("---\ntitle: Abcd\n---\n", app.gap, 50);
    editFront("---\ntitle: Abcde\n---\n");
    undo(view.state, view.dispatch);
    expect(app.front).toBe("---\ntitle: Abcd\n---\n");
    undo(view.state, view.dispatch);
    expect(app.front).toBe(FRONT);
    await editor.destroy();
  });

  it("brings back the blank lines after properties that were all removed", async () => {
    const { editor, view, app, editFront } = await setup();
    editFront("", "");
    undo(view.state, view.dispatch);
    expect(app).toMatchObject({ front: FRONT, gap: "\n" });
    await editor.destroy();
  });

  it("skips a frontmatter undo that a change from outside made stale", async () => {
    const { editor, view, app, type, editFront, text } = await setup();
    type("!");
    editFront(setProperty(FRONT, "a", "1"));
    // The file's frontmatter changed in the source editor.
    const outside = "---\ntitle: Other\n---\n";
    app.front = outside;
    resetFront(view, { front: outside, gap: "\n" });
    // One press goes past the stale frontmatter step to the typing before it.
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(text()).toBe("Hello");
    expect(app.front).toBe(outside);
    expect(historyFront(view.state)?.front).toBe(outside);
    // Redo skips it the same way.
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(text()).toBe("Hello!");
    expect(app.front).toBe(outside);
    expect(app.restored).toEqual([]);
    await editor.destroy();
  });

  it("skips several stale frontmatter undos in one press, and stops when nothing else is left", async () => {
    const { editor, view, app, type, editFront, text } = await setup();
    type("!");
    editFront(setProperty(FRONT, "a", "1"));
    editFront(setProperty(setProperty(FRONT, "a", "1"), "b", "2"));
    const outside = "---\ntitle: Other\n---\n";
    app.front = outside;
    resetFront(view, { front: outside, gap: "\n" });
    undo(view.state, view.dispatch);
    expect(text()).toBe("Hello");
    expect(app.front).toBe(outside);
    // Nothing visible is left to undo.
    const doc = view.state.doc;
    undo(view.state, view.dispatch);
    expect(view.state.doc).toBe(doc);
    expect(app.front).toBe(outside);
    await editor.destroy();
  });

  it("still undoes a frontmatter edit made after the change from outside", async () => {
    const { editor, view, app, type, editFront, text } = await setup();
    type("!");
    editFront(setProperty(FRONT, "a", "1"));
    const outside = "---\ntitle: Other\n---\n";
    app.front = outside;
    resetFront(view, { front: outside, gap: "\n" });
    const edited = setProperty(outside, "b", "2");
    editFront(edited);
    undo(view.state, view.dispatch);
    expect(app.front).toBe(outside);
    expect(text()).toBe("Hello!");
    undo(view.state, view.dispatch);
    expect(text()).toBe("Hello");
    expect(app.front).toBe(outside);
    redo(view.state, view.dispatch);
    expect(text()).toBe("Hello!");
    redo(view.state, view.dispatch);
    expect(app.front).toBe(edited);
    await editor.destroy();
  });

  it("leaves the document itself alone", async () => {
    const { editor, view, editFront } = await setup();
    const doc = view.state.doc;
    editFront(setProperty(FRONT, "a", "1"));
    expect(view.state.doc).toBe(doc);
    undo(view.state, view.dispatch);
    expect(view.state.doc).toBe(doc);
    await editor.destroy();
  });
});

describe("a frontmatter-only edit", () => {
  // Syntax the serializer would normalize if it rewrote the body.
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
    "Section",
    "-------",
    "",
    "Text.",
    "",
  ].join("\n");

  it("writes the body's bytes exactly as they were", async () => {
    const { editor, view, app, editFront } = await setup(BODY);
    const baseline = new BodyBaseline();
    let serialized = 0;
    const serialize = () => (serialized++, editor.markdown());
    baseline.remember(view.state.doc, editor.markdown(), "", BODY);
    // The serializer would have changed it.
    expect(editor.markdown()).not.toBe(BODY);

    const edited = setProperty(FRONT, "ken-heading-numbering", "1.a");
    editFront(edited);
    const text = joinDocument(app.front, app.gap, baseline.body(view.state.doc, "", serialize, (md) => md));
    expect(text).toBe(edited + "\n" + BODY);
    expect(serialized).toBe(0);

    // Removing every property too.
    editFront("", "");
    expect(joinDocument(app.front, app.gap, baseline.body(view.state.doc, "", serialize, (md) => md))).toBe(BODY);
    await editor.destroy();
  });

  it("still keeps the bytes after a change that serializes the same, and not after a real edit", async () => {
    const { editor, view, type } = await setup(BODY);
    const baseline = new BodyBaseline();
    baseline.remember(view.state.doc, editor.markdown(), "", BODY);
    // A new document object saying the same thing.
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { ...view.state.doc.firstChild!.attrs }));
    expect(baseline.body(view.state.doc, "", editor.markdown, (md) => md)).toBe(BODY);
    type("!");
    const after = baseline.body(view.state.doc, "", editor.markdown, (md) => md);
    expect(after).toBe(editor.markdown());
    expect(after).toContain("Text.!");
    await editor.destroy();
  });
});
