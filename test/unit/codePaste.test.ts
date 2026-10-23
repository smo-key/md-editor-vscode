// Pasting into code (code blocks, math and mermaid fences, inline code) on the
// real editor: the clipboard's plain text goes in verbatim, never Markdown
// parsed or escaped (webview/markdown/codePaste.ts).
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { EditorView as CMView } from "@codemirror/view";
import { EditorState as CMState } from "@codemirror/state";

import { codePasteExtension, codePasteText } from "../../webview/markdown/codePaste";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

type Mounted = Awaited<ReturnType<typeof mountEditor>>;

function viewOf(ed: Mounted): EditorView {
  return ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
}

async function withEditor(markdown: string, fn: (view: EditorView, out: () => string) => void | Promise<void>) {
  const ed = await mountEditor(markdown);
  try {
    await fn(viewOf(ed), () => normalizeTrailingNewlines(ed.markdown()));
  } finally {
    await ed.destroy();
  }
}

function transfer(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    getData: (t: string) => data[t] ?? "",
  } as unknown as DataTransfer;
}

/** Fire a paste at `target` as the browser would; true when it was handled. */
function paste(target: EventTarget, data: Record<string, string>): boolean {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: transfer(data) });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Position of the first match of `text` in a text node (start, or end with `after`). */
function posOf(view: EditorView, text: string, after = false): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (!node.isText) return true;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i + (after ? text.length : 0);
    return false;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function caret(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

/** Inside the (only) code block, after its text. */
function caretInCode(view: EditorView, index = 0) {
  let n = 0;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.type.name === "code_block" && n++ === index) at = pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) throw new Error("no code block");
  caret(view, at);
}

function codeText(view: EditorView, index = 0): string {
  const blocks: string[] = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === "code_block") blocks.push(node.textContent);
    return !node.isTextblock;
  });
  return blocks[index];
}

/** What the editor puts on the clipboard for `from..to` (a real copy). */
function copy(view: EditorView, from: number, to: number): Record<string, string> {
  const slice = view.state.doc.slice(from, to);
  const { dom, text } = view.serializeForClipboard(slice);
  return { "text/plain": text, "text/html": dom.innerHTML };
}

// Copied from VS Code's text editor: a <div> per line, spaces as &nbsp;.
const vscodeHtml =
  '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Menlo;white-space: pre;">' +
  '<div><span style="color: #569cd6;">const</span><span>&nbsp;a_b&nbsp;=&nbsp;</span><span>"*x*"</span><span>;</span></div>' +
  "<div><span>&nbsp;&nbsp;&nbsp;&nbsp;#&nbsp;[y](z)&nbsp;\\n</span></div></div>";
const vscodeText = 'const a_b = "*x*";\n    # [y](z) \\n';

describe("codePasteText", () => {
  it("is the plain text verbatim, CRLF as LF", () => {
    const text = "  a_b *c* #d [e](f) <g> &amp; \\n\r\n\tend  ";
    expect(codePasteText(transfer({ "text/plain": text, "text/html": "<p>ignored</p>" }))).toBe(
      "  a_b *c* #d [e](f) <g> &amp; \\n\n\tend  ",
    );
  });

  it("reads VS Code's HTML only when there is no plain text (&nbsp; as spaces)", () => {
    expect(codePasteText(transfer({ "text/plain": vscodeText, "text/html": vscodeHtml }))).toBe(vscodeText);
    expect(codePasteText(transfer({ "text/html": vscodeHtml }))).toBe(vscodeText);
  });

  it("reads a browser's HTML lines when there is no plain text", () => {
    expect(codePasteText(transfer({ "text/html": "<p>a_b&nbsp; c</p><pre><code>x\n  y</code></pre>a<br>b" }))).toBe(
      "a_b  c\nx\n  y\na\nb",
    );
  });

  it("is null with nothing to paste", () => {
    expect(codePasteText(transfer({}))).toBeNull();
  });
});

describe("pasting into a code block", () => {
  it("inserts VS Code's text verbatim", async () => {
    await withEditor("```js\nlet x;\n```\n", (view, out) => {
      caretInCode(view);
      expect(paste(view.dom, { "text/plain": vscodeText, "text/html": vscodeHtml })).toBe(true);
      expect(codeText(view)).toBe("let x;" + vscodeText);
      expect(out()).toBe("```js\nlet x;" + vscodeText + "\n```\n");
    });
  });

  it("inserts a browser's text verbatim, whitespace and newlines kept", async () => {
    await withEditor("```\n```\n", (view, out) => {
      caretInCode(view);
      const text = "  _a_ *b* \\c\n\n\t# d  ";
      paste(view.dom, { "text/plain": text, "text/html": "<pre>  <em>a</em> ...</pre>" });
      expect(codeText(view)).toBe(text);
      expect(out()).toBe("```\n" + text + "\n```\n");
    });
  });

  it("gives text copied from the editor as its rendered text, not escaped Markdown", async () => {
    await withEditor("Use `a_b`, **bold** and *c\\_d* #tag \\[x] $x_1$\n\n- one\n- two\n\n```\n```\n", (view) => {
      const listEnd = posOf(view, "two", true);
      const data = copy(view, 1, listEnd);
      // The plain text is Markdown with escapes; that must not reach the code.
      expect(data["text/plain"]).toMatch(/\\_|\\\[|\*\*/);
      caretInCode(view);
      paste(view.dom, data);
      expect(codeText(view)).toBe("Use a_b, bold and c_d #tag [x] x_1\none\ntwo");
    });
  });

  it("keeps a copied code block's text as is", async () => {
    await withEditor("```py\n  def f(a_b):\n      return '*'\n```\n\n```\n```\n", (view) => {
      let first: { from: number; to: number } | undefined;
      view.state.doc.descendants((node, pos) => {
        if (!first && node.type.name === "code_block") first = { from: pos, to: pos + node.nodeSize };
        return false;
      });
      const data = copy(view, first!.from, first!.to);
      caretInCode(view, 1);
      paste(view.dom, data);
      expect(codeText(view, 1)).toBe("  def f(a_b):\n      return '*'");
    });
  });

  it("covers math and mermaid blocks", async () => {
    await withEditor("```math\n```\n\n```mermaid\n```\n", (view, out) => {
      caretInCode(view, 0);
      paste(view.dom, { "text/plain": "a_{1} \\cdot *b*" });
      caretInCode(view, 1);
      paste(view.dom, { "text/plain": "graph TD\n  A[x_y] --> B" });
      expect(out()).toBe("```math\na_{1} \\cdot *b*\n```\n\n```mermaid\ngraph TD\n  A[x_y] --> B\n```\n");
    });
  });
});

describe("pasting into inline code", () => {
  it("inserts plain text into the code mark", async () => {
    await withEditor("See `ab` here.\n", (view, out) => {
      caret(view, posOf(view, "ab") + 1);
      expect(paste(view.dom, { "text/plain": "*x*_[y]", "text/html": "<em>x</em>" })).toBe(true);
      expect(out()).toBe("See `a*x*_[y]b` here.\n");
    });
  });

  it("gives text copied from the editor as rendered text", async () => {
    await withEditor("**b_c** d\n\nSee `ab` here.\n", (view, out) => {
      const data = copy(view, 1, posOf(view, "d", true));
      caret(view, posOf(view, "ab") + 1);
      paste(view.dom, data);
      expect(out()).toBe("**b\\_c** d\n\nSee `ab_c db` here.\n");
    });
  });

  it("joins lines with spaces (inline code is one line)", async () => {
    await withEditor("See `ab` here.\n", (view, out) => {
      caret(view, posOf(view, "ab") + 1);
      paste(view.dom, { "text/plain": "x\r\ny\nz" });
      expect(out()).toBe("See `ax y zb` here.\n");
    });
  });
});

describe("pasting outside code", () => {
  it("still parses Markdown", async () => {
    await withEditor("Text.\n", (view, out) => {
      caret(view, posOf(view, "Text.", true));
      expect(paste(view.dom, { "text/plain": "**b** _i_" })).toBe(true);
      expect(out()).toBe("Text.**b** *i*\n");
    });
  });
});

describe("CodeMirror (a mounted code block)", () => {
  function cm(doc: string) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new CMView({ parent, state: CMState.create({ doc, extensions: [codePasteExtension] }) });
    view.dispatch({ selection: { anchor: doc.length } });
    return view;
  }

  it("replaces editor-copied text with its rendered text", async () => {
    await withEditor("**a_b** \\[c]\n", (pm) => {
      const data = copy(pm, 1, posOf(pm, "[c]", true));
      const view = cm("x");
      expect(paste(view.contentDOM, data)).toBe(true);
      expect(view.state.doc.toString()).toBe("xa_b [c]");
      view.destroy();
    });
  });

  it("leaves other pastes to CodeMirror (its plain text)", () => {
    const view = cm("x");
    paste(view.contentDOM, { "text/plain": vscodeText, "text/html": vscodeHtml });
    expect(view.state.doc.toString()).toBe("x" + vscodeText);
    view.destroy();
  });

  it("reads HTML when there is no plain text", () => {
    const view = cm("");
    expect(paste(view.contentDOM, { "text/html": vscodeHtml })).toBe(true);
    expect(view.state.doc.toString()).toBe(vscodeText);
    view.destroy();
  });
});
