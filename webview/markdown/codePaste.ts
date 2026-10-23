/**
 * Pasting into code: a code block (math and mermaid fences included) or inline
 * code gets the clipboard's plain text verbatim, never Markdown parsed or
 * escaped.
 *
 * Text from elsewhere (VS Code, a browser) already pastes as its text/plain.
 * Text copied from this editor does not: Milkdown's clipboard plugin writes the
 * selection's Markdown source as text/plain (`\_`, `\[`, `**`, `&#x20;`), so
 * that a paste into another Markdown file keeps the formatting. Into code, the
 * rendered text is what was meant (what the reader saw and what a browser copy
 * gives), so a ProseMirror copy (HTML marked `data-pm-slice`) pastes the text
 * of its HTML instead.
 *
 * Two paths: a code block with its CodeMirror mounted handles its own events
 * (`codePasteExtension`); otherwise ProseMirror gets the paste
 * (`codePastePlugin`), ahead of Milkdown's Markdown parsing.
 */
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

const BLOCKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "THEAD", "TFOOT", "TR", "UL",
]);
const SKIP = new Set(["HEAD", "META", "SCRIPT", "STYLE", "TEMPLATE", "TITLE"]);

/** HTML copied from a ProseMirror editor (this one included). */
const isEditorCopy = (html: string) => /\bdata-pm-slice=/.test(html);

/**
 * The text of clipboard HTML: one line per block, `<br>` as a line break,
 * cells tab-separated, `&nbsp;` as a space. ProseMirror's HTML keeps its
 * whitespace (the editor shows it as is); other HTML collapses it outside
 * `<pre>` and `white-space: pre`, as a browser shows it.
 */
export function htmlText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const literal = isEditorCopy(html);
  let out = "";
  let pendingBreak = false;
  const breakLine = () => {
    if (out && !out.endsWith("\n")) pendingBreak = true;
  };
  const write = (s: string) => {
    if (!s) return;
    if (pendingBreak) out += "\n";
    pendingBreak = false;
    out += s;
  };
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let s = node.nodeValue ?? "";
      if (!pre && !literal) {
        s = s.replace(/[ \t\r\n]+/g, " ");
        if (out.endsWith(" ") || out.endsWith("\n") || pendingBreak || !out) s = s.replace(/^ /, "");
      }
      // After collapsing: a non-breaking space is a real one.
      write(s.replace(/ /g, " "));
      return;
    }
    if (!(node instanceof Element)) {
      node.childNodes.forEach((child) => walk(child, pre));
      return;
    }
    const tag = node.tagName;
    if (SKIP.has(tag)) return;
    if (tag === "BR") {
      pendingBreak = false;
      out += "\n";
      return;
    }
    if ((tag === "TD" || tag === "TH") && node.previousElementSibling) write("\t");
    const block = BLOCKS.has(tag);
    if (block) breakLine();
    const ws = (node as HTMLElement).style?.whiteSpace ?? "";
    const inPre = pre || tag === "PRE" || /^pre/.test(ws) || ws === "break-spaces";
    node.childNodes.forEach((child) => walk(child, inPre));
    if (block) breakLine();
  };
  walk(template.content, false);
  return out;
}

/**
 * What a paste into code inserts: the plain text (CRLF as LF), or the text of
 * the HTML for a copy from a ProseMirror editor or when there is no plain
 * text. Null when the clipboard has neither.
 */
export function codePasteText(data: DataTransfer | null): string | null {
  if (!data) return null;
  const html = data.getData("text/html");
  const plain = data.getData("text/plain");
  const text = (html && (isEditorCopy(html) || !plain) ? htmlText(html) : plain).replace(/\r\n?/g, "\n");
  return text || plain ? text : null;
}

/** For CodeMirror: the editor's own copies paste as their rendered text. */
export const codePasteExtension = CodeMirrorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    const html = data?.getData("text/html") ?? "";
    // Plain text is CodeMirror's own default.
    if (!html || (!isEditorCopy(html) && data?.getData("text/plain"))) return false;
    const text = codePasteText(data);
    if (text === null) return false;
    event.preventDefault();
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
    return true;
  },
});

/** "block" in a code block, "inline" in inline code, else null. */
function codeContext(state: EditorState): "block" | "inline" | null {
  const { $from, $to, empty } = state.selection;
  if ($from.parent.type.spec.code && $from.sameParent($to)) return "block";
  const inCode = (marks: readonly { type: { spec: { code?: boolean } } }[]) => marks.some((m) => m.type.spec.code);
  if (!$from.parent.isTextblock || !$from.sameParent($to)) return null;
  if (empty) return inCode(state.storedMarks ?? $from.marks()) ? "inline" : null;
  return inCode($from.marksAcross($to) ?? []) && inCode($from.marks()) ? "inline" : null;
}

/** For ProseMirror: code gets plain text, before any Markdown parsing. */
export const codePastePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-code-paste"),
      props: {
        handleDOMEvents: {
          paste: (view, event) => {
            if (!view.editable) return false;
            const where = codeContext(view.state);
            if (!where) return false;
            let text = codePasteText(event.clipboardData);
            if (text === null) return false;
            // Inline code is one line.
            if (where === "inline") text = text.replace(/\n/g, " ");
            event.preventDefault();
            const { from, to } = view.state.selection;
            view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView().setMeta("uiEvent", "paste"));
            return true;
          },
        },
      },
    }),
);
