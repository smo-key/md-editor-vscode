/**
 * "Copy link to heading" affordance for the Markdown editor.
 *
 * Hovering a heading reveals a small link button in the left gutter; clicking
 * it puts `[Heading text](#slug)` on the clipboard. The slug is the same
 * GitHub-style one `anchors.ts` resolves on click, so a pasted link scrolls to
 * the heading it came from.
 *
 * Crepe parks its own block drag/insert handle in that gutter, 82px to 16px
 * left of the text, and shows it on the same hover — so the button sits
 * further out still, clear of it (see the CSS in MarkdownEditor.svelte).
 * Headings nested in a blockquote or an alert get no button: there the gutter
 * belongs to the container's own left rule.
 *
 * The button is a ProseMirror widget decoration: it lives purely in the view
 * layer, so it can never reach the document, the serialized markdown or the
 * undo history, and heading editing (Backspace at the start included) is
 * untouched because no document position moves.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

import { collectHeadings } from "./anchors";

/** Class of the injected button, also used by the editor's CSS. */
export const HEADING_LINK_CLASS = "ken-heading-link";

/** How long the button shows its "copied" tick. */
const FEEDBACK_MS = 1200;

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// lucide `link` and `check`.
const LINK_ICON = icon(
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
);
const CHECK_ICON = icon('<path d="M20 6 9 17l-5-5"/>');

/** The Markdown link a heading's button copies. */
export function headingLinkMarkdown(text: string, slug: string): string {
  return `[${text}](#${slug})`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function makeButton(text: string, slug: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = HEADING_LINK_CLASS;
  button.contentEditable = "false";
  button.setAttribute("data-testid", "heading-link");
  button.setAttribute("data-slug", slug);
  button.title = "Copy link to this heading";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = LINK_ICON;

  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void copy(headingLinkMarkdown(text, slug)).then((ok) => {
      if (!ok) return;
      button.classList.add("copied");
      button.innerHTML = CHECK_ICON;
      button.title = "Copied";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove("copied");
        button.innerHTML = LINK_ICON;
        button.title = "Copy link to this heading";
      }, FEEDBACK_MS);
    });
  });
  return button;
}

function build(doc: ProseNode): DecorationSet {
  const decorations = collectHeadings(doc)
    .filter(
      (heading) =>
        heading.slug.length > 0 &&
        // Only headings that own the gutter: one inside a blockquote, an alert
        // or a list item would put the button on top of that block's own edge.
        doc.resolve(heading.pos).depth === 0,
    )
    .map((heading) =>
      Decoration.widget(
        // The start of the heading's text. The button is absolutely
        // positioned, so it takes no space in the line, and `side: -1` keeps
        // the caret after it — Backspace at the start of a heading is
        // unaffected because no document position moves either way.
        heading.pos + 1,
        () => makeButton(heading.text, heading.slug),
        {
          side: -1,
          key: `ken-heading-link:${heading.slug}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    );
  return DecorationSet.create(doc, decorations);
}

const headingLinkKey = new PluginKey<DecorationSet>("ken-heading-link");

/** The hover "copy link" button on every heading. */
export const headingLinkPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: headingLinkKey,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (tr, previous) => (tr.docChanged ? build(tr.doc) : previous),
      },
      props: {
        decorations: (state) => headingLinkKey.getState(state),
      },
    }),
);
