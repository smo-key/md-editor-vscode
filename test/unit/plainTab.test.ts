// Tab in a plain paragraph types a real tab character (markdown/plainTab.ts),
// pressed as a real keydown on the real editor; the tab survives saving and
// reopening. (Code blocks keep CodeMirror's own Tab: CodeMirror mounts lazily,
// so harness/check-list-tab.mjs covers that in Chromium.)
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { DEFAULT_TAB_SIZE, tabSizeValue } from "../../src/tabSize";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

function press(target: Element, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string) => void | Promise<void>) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    await fn(view, () => normalizeTrailingNewlines(ed.markdown()));
  } finally {
    await ed.destroy();
  }
}

/** Open `markdown`, and give back the first block's type and text. */
async function reopen(markdown: string) {
  let out = { type: "", text: "", md: "" };
  await withEditor(markdown, (view, md) => {
    const first = view.state.doc.firstChild!;
    out = { type: first.type.name, text: first.textContent, md: md() };
  });
  return out;
}

/** Type Tab with the caret at `offset` in the first paragraph; the saved Markdown. */
async function tabAt(markdown: string, offset: number) {
  let saved = "";
  let text = "";
  await withEditor(markdown, (view, md) => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + offset)));
    expect(press(view.dom, "Tab")).toBe(true);
    text = view.state.doc.firstChild!.textContent;
    saved = md();
  });
  return { text, saved };
}

describe("Tab in a plain paragraph", () => {
  it("inserts a tab character, not spaces, inside a line", async () => {
    const { text, saved } = await tabAt("text\n", 2);
    expect(text).toBe("te\txt");
    expect(saved).toBe("te\txt\n");
    expect(await reopen(saved)).toMatchObject({ type: "paragraph", text: "te\txt", md: saved });
  });

  it("a leading tab is saved as &#x9;, so it reopens as a paragraph, not indented code", async () => {
    const { text, saved } = await tabAt("text\n", 0);
    expect(text).toBe("\ttext");
    expect(saved).toBe("&#x9;text\n");
    expect(await reopen(saved)).toMatchObject({ type: "paragraph", text: "\ttext", md: saved });
  });

  it("a trailing tab is saved as &#x9;, so it isn't dropped on reopening", async () => {
    const { text, saved } = await tabAt("text\n", 4);
    expect(text).toBe("text\t");
    expect(saved).toBe("text&#x9;\n");
    expect(await reopen(saved)).toMatchObject({ type: "paragraph", text: "text\t", md: saved });
  });

  it("a paragraph that is only a tab survives", async () => {
    const { saved } = await tabAt("a\n\nb\n", 1);
    expect(saved).toBe("a&#x9;\n\nb\n");
    let tabOnly = "";
    await withEditor("a\n\nb\n", (view, md) => {
      view.dispatch(view.state.tr.delete(1, 2));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      press(view.dom, "Tab");
      tabOnly = md();
    });
    expect(tabOnly).toBe("&#x9;\n\nb\n");
    expect(await reopen(tabOnly)).toMatchObject({ type: "paragraph", text: "\t" });
  });

  it("files with tabs are not rewritten by opening them", async () => {
    for (const md of ["a\tb\n", "&#x9;lead\n", "tail&#x9;\n", "**a**\tb\n"]) {
      expect((await reopen(md)).md).toBe(md);
    }
  });
});

describe("tabSizeValue (editor.tabSize to the webview)", () => {
  it("passes whole sizes through", () => {
    expect(tabSizeValue(2)).toBe(2);
    expect(tabSizeValue(8)).toBe(8);
    expect(tabSizeValue("3")).toBe(3);
  });

  it("falls back to 4 for missing or invalid values", () => {
    for (const v of [undefined, null, "", "auto", NaN, 0, -2, 100, {}]) {
      expect(tabSizeValue(v)).toBe(DEFAULT_TAB_SIZE);
    }
    expect(DEFAULT_TAB_SIZE).toBe(4);
  });

  it("rounds fractional sizes", () => {
    expect(tabSizeValue(2.4)).toBe(2);
  });
});
