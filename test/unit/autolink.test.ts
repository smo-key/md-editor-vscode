// Typed URLs become links once finished, as GFM finds them, and save bare.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { autolinkAtEnd, trimAutolink } from "../../webview/markdown/autolink";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

describe("GFM extended autolink rules", () => {
  it.each([
    ["see https://example.com/a?b=1", "https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["go www.example.com/path", "www.example.com/path", "http://www.example.com/path"],
    ["end https://example.com.", "https://example.com", "https://example.com"],
    ["(https://example.com/a_(b))", "https://example.com/a_(b)", "https://example.com/a_(b)"],
    ["(see https://example.com/x)", "https://example.com/x", "https://example.com/x"],
    ["mail me@example.org", "me@example.org", "mailto:me@example.org"],
    ["*https://x.io*", "https://x.io", "https://x.io"],
  ])("%s → %s", (text, linked, href) => {
    const found = autolinkAtEnd(text)!;
    expect(text.slice(found.start, found.end)).toBe(linked);
    expect(found.href).toBe(href);
  });

  it.each(["plain words", "https://localhost", "www.example_x.com", "http://", "me@nodot"])("leaves %s alone", (text) => {
    expect(autolinkAtEnd(text)).toBeNull();
  });

  it("trims entity references and sentence punctuation", () => {
    expect(trimAutolink("www.a.com/?x&amp;")).toBe("www.a.com/?x");
    expect(trimAutolink("https://a.com/b!?")).toBe("https://a.com/b");
  });
});

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string) => void) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    fn(view, () => normalizeTrailingNewlines(ed.markdown()));
  } finally {
    await ed.destroy();
  }
}

/** Type `text` at the end of the first paragraph, as the browser would. */
function type(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

function caretAtEnd(view: EditorView) {
  const end = view.state.doc.firstChild!.nodeSize - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
}

describe("typing a URL", () => {
  it("links it at the space after it, outside the sentence's full stop, and saves it bare", async () => {
    await withEditor("Read\n", (view, md) => {
      caretAtEnd(view);
      type(view, " https://example.com/docs. Next");
      expect(md()).toBe("Read https://example.com/docs. Next\n");
      const marks = view.state.doc.firstChild!.child(1).marks.map((m) => m.attrs.href);
      expect(marks).toEqual(["https://example.com/docs"]);
    });
  });

  it("links www. addresses and emails, not text that isn't a URL", async () => {
    await withEditor("x\n", (view) => {
      caretAtEnd(view);
      type(view, " www.example.com and me@example.org and example.com ");
      const links: string[] = [];
      view.state.doc.descendants((n) => {
        const l = n.marks.find((m) => m.type.name === "link");
        if (l) links.push(`${n.text}→${l.attrs.href}`);
      });
      expect(links).toEqual(["www.example.com→http://www.example.com", "me@example.org→mailto:me@example.org"]);
    });
  });

  it("links on Enter", async () => {
    await withEditor("Go https://example.com\n", (view) => {
      caretAtEnd(view);
      view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(view.state.doc.childCount).toBeGreaterThan(1);
      const link = view.state.doc.firstChild!.lastChild!.marks.find((m) => m.type.name === "link");
      expect(link?.attrs.href).toBe("https://example.com");
    });
  });

  it("leaves code alone", async () => {
    await withEditor("`code`\n", (view, md) => {
      const pos = 5;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
      type(view, "https://a.com ");
      expect(md()).not.toContain("[");
      expect(view.state.doc.textContent).toContain("https://a.com ");
      let linked = false;
      view.state.doc.descendants((n) => {
        if (n.marks.some((m) => m.type.name === "link")) linked = true;
      });
      expect(linked).toBe(false);
    });
  });
});
