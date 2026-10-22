// Comments: markers in the Markdown, the threads block, and keeping both
// valid through edits (on the real editor).
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { addCommentRange, commentRanges, removeCommentRange } from "../../webview/comments/anchors";
import { formatThreads, parseThreads, splitThreads, ThreadStore } from "../../webview/comments/store";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

async function withDoc(md: string, fn: (view: EditorView, out: () => string) => void | Promise<void>) {
  const ed = await mountEditor(md);
  const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    await fn(view, () => normalizeTrailingNewlines(ed.markdown()));
  } finally {
    await ed.destroy();
  }
}

function find(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i;
    return false;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function select(view: EditorView, fromText: string, toText: string) {
  const from = find(view, fromText);
  const to = find(view, toText) + toText.length;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

describe("threads block", () => {
  it("splits off, parses and formats (one thread per line, -- escaped)", () => {
    const threads = [
      { id: "c1", resolved: false, messages: [{ id: "m1", author: "Ana", date: "2026-10-22T15:00:00.000Z", text: "Source? <!-- nope --> ok" }] },
      { id: "c2", resolved: true, messages: [{ id: "m1", author: "Ben", date: "", text: "Done" }] },
    ];
    const block = formatThreads(threads);
    expect(block.split("\n").length).toBe(5);
    expect(block).not.toMatch(/--[^>]*-->[\s\S]*-->/);
    const doc = `# Doc\n\nText.\n\n${block}`;
    const { body, block: got } = splitThreads(doc);
    expect(body).toBe("# Doc\n\nText.\n");
    expect([...parseThreads(got).values()]).toEqual(threads);
  });

  it("survives a damaged line", () => {
    const block = '<!-- ken:comments\n{"c1":{"resolved":false,"messages":[{"id":"m1","author":"A","date":"","text":"ok"}]},\n "c2":{broken\n-->\n';
    expect([...parseThreads(block).keys()]).toEqual(["c1"]);
  });

  it("writes only threads that have markers, in document order", () => {
    const store = new ThreadStore();
    store.author = "Ana";
    store.reply("b", "second");
    store.reply("a", "first");
    store.reply("gone", "x");
    const out = store.format(["a", "b"]);
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out).not.toContain("gone");
  });
});

describe("comment markers", () => {
  it("round-trip inline, across blocks, and around a table", async () => {
    const md = [
      "Revenue grew <!-- ken:comment c1 -->**12%** in Q3.",
      "",
      "<!-- ken:comment c2 -->",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "<!-- /ken:comment c2 -->",
      "",
      "And <!-- /ken:comment c1 -->more.",
      "",
    ].join("\n");
    await withDoc(md, (view, out) => {
      expect(out()).toBe(md);
      expect(commentRanges(view.state.doc).map((r) => r.id)).toEqual(["c1", "c2"]);
    });
  });

  it("wraps a selection in markers, and removes them again", async () => {
    await withDoc("One two three.\n\nFour five.\n", (view, out) => {
      select(view, "two", "Four");
      view.dispatch(addCommentRange(view.state, "c1")!);
      expect(out()).toBe("One <!-- ken:comment c1 -->two three.\n\nFour<!-- /ken:comment c1 --> five.\n");
      view.dispatch(removeCommentRange(view.state, "c1")!);
      expect(out()).toBe("One two three.\n\nFour five.\n");
    });
  });

  it("never writes a marker at the start of a line", async () => {
    await withDoc("First paragraph.\n\nSecond paragraph.\n", (view, out) => {
      select(view, "Second", "paragraph.");
      // "Second" starts its paragraph: an inline marker there would open an HTML block.
      const second = find(view, "Second");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, second, second + 6)));
      view.dispatch(addCommentRange(view.state, "c1")!);
      const md = out();
      expect(md).toBe("First paragraph.\n\n<!-- ken:comment c1 -->\n\nSecond<!-- /ken:comment c1 --> paragraph.\n");
      for (const line of md.split("\n")) {
        if (line.startsWith("<!--")) expect(line).toMatch(/^<!-- \/?ken:comment c1 -->$/);
      }
    });
    await withDoc("- one\n- two\n", (view, out) => {
      const two = find(view, "two");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, two, two + 3)));
      view.dispatch(addCommentRange(view.state, "c1")!);
      // Not "- <!-- …": the start goes to the end of the previous item's line.
      expect(out()).toBe("- one<!-- ken:comment c1 -->\n- two<!-- /ken:comment c1 -->\n");
    });
  });

  it("snaps out of code blocks to the block's edges", async () => {
    await withDoc("Intro.\n\n```js\nconst x = 1;\n```\n\nAfter.\n", (view, out) => {
      select(view, "const", "1;");
      view.dispatch(addCommentRange(view.state, "c1")!);
      expect(out()).toBe("Intro.\n\n<!-- ken:comment c1 -->\n\n```js\nconst x = 1;\n```\n\n<!-- /ken:comment c1 -->\n\nAfter.\n");
    });
  });

  it("deleting content that holds one end keeps the comment on what is left", async () => {
    await withDoc("Keep this. Remove that.\n", (view, out) => {
      select(view, "this", "that");
      view.dispatch(addCommentRange(view.state, "c1")!);
      // Delete from "Remove" to the end of the paragraph: the end marker goes with it.
      const from = find(view, " Remove");
      const to = view.state.selection.$from.end();
      view.dispatch(view.state.tr.delete(from, to));
      expect(out()).toBe("Keep <!-- ken:comment c1 -->this.<!-- /ken:comment c1 -->\n");
    });
  });

  it("deleting a whole section holding a comment removes the markers, not the text around", async () => {
    await withDoc("# Keep\n\nBefore.\n\n## Drop\n\nBody with a note.\n\nAfter.\n", (view, out) => {
      select(view, "with", "note");
      view.dispatch(addCommentRange(view.state, "c1")!);
      const from = find(view, "Drop") - 1;
      const to = find(view, "After.") - 1;
      view.dispatch(view.state.tr.delete(from, to));
      expect(out()).toBe("# Keep\n\nBefore.\n\nAfter.\n");
      expect(commentRanges(view.state.doc)).toEqual([]);
    });
  });

  it("deleting a table at the end of a range moves the end before it", async () => {
    await withDoc("Note on this table:\n\n| A |\n| - |\n| 1 |\n\nAfter.\n", (view, out) => {
      select(view, "this", "1");
      view.dispatch(addCommentRange(view.state, "c1")!);
      const table = find(view, "A") - 3;
      let tablePos = -1;
      view.state.doc.forEach((n, p) => {
        if (n.type.name === "table") tablePos = p;
      });
      void table;
      const node = view.state.doc.nodeAt(tablePos)!;
      view.dispatch(view.state.tr.delete(tablePos, tablePos + node.nodeSize));
      const md = out();
      expect(md).toContain("<!-- ken:comment c1 -->this table:");
      expect(md).toContain("<!-- /ken:comment c1 -->");
      expect(md.indexOf("/ken:comment")).toBeLessThan(md.indexOf("After."));
      expect(commentRanges(view.state.doc).length).toBe(1);
    });
  });

  it("drops markers from pasted content (no duplicate comments)", async () => {
    await withDoc("Alpha beta gamma.\n\nTarget.\n", (view, out) => {
      select(view, "beta", "beta");
      view.dispatch(addCommentRange(view.state, "c1")!);
      const slice = view.state.doc.slice(find(view, "Alpha"), find(view, " gamma"));
      const target = find(view, "Target");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
      view.pasteHTML?.("");
      // Simulate the paste path: transformPasted strips markers.
      const pasted = view.someProp("transformPasted", (f) => f(slice, view)) ?? slice;
      view.dispatch(view.state.tr.replaceSelection(pasted));
      expect(out().match(/ken:comment c1/g)?.length).toBe(2);
    });
  });

  it("Backspace right after a marker deletes the character before it", async () => {
    await withDoc("abc def\n", (view, out) => {
      select(view, "def", "def");
      view.dispatch(addCommentRange(view.state, "c1")!);
      // Caret right after the start marker, before "def".
      const start = find(view, "def");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
      expect(out()).toBe("abc<!-- ken:comment c1 -->def<!-- /ken:comment c1 -->\n");
    });
  });
});
