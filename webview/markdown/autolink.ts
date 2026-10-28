/**
 * Typed URLs become links, the way GitHub-flavoured Markdown finds them
 * (extended autolinks): `https://…`, `http://…`, `www.…` and email
 * addresses, turned into links once the URL is finished, i.e. when a space,
 * a new line or `<` follows it. Trailing punctuation that ends a sentence
 * (`.`, `,`, `:`, `!`, `?`, `*`, `_`, `~`), an unbalanced `)` and a trailing
 * entity reference stay outside the link, as GFM has it.
 *
 * The link is marked as a literal (markdown/linkFidelity.ts), so it is saved
 * bare, just as it was typed, and GitHub links it the same way.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { $prose } from "@milkdown/kit/utils";

export interface FoundLink {
  /** Offsets of the link text in the scanned string. */
  start: number;
  end: number;
  href: string;
}

const TRAILING = /[?!.,:*_~]$/;
/** Characters GFM allows directly before an extended autolink. */
const LEAD = /[*_~(]/;

/** A valid GFM domain: segments of letters, digits, `_` and `-`, at least one period, no `_` in the last two. */
function validDomain(domain: string): boolean {
  const parts = domain.split(".");
  if (parts.length < 2 || parts.some((p) => !/^[\w-]+$/.test(p))) return false;
  return !parts.slice(-2).some((p) => p.includes("_"));
}

/** GFM's extended autolink path end: drop trailing punctuation, unbalanced `)`, entity references. */
export function trimAutolink(text: string): string {
  let s = text;
  for (;;) {
    if (TRAILING.test(s)) {
      s = s.slice(0, -1);
      continue;
    }
    if (s.endsWith(")")) {
      const open = (s.match(/\(/g) ?? []).length;
      const close = (s.match(/\)/g) ?? []).length;
      if (close > open) {
        s = s.slice(0, -1);
        continue;
      }
    }
    const entity = /&[a-zA-Z0-9]+;$/.exec(s);
    if (entity) {
      s = s.slice(0, entity.index);
      continue;
    }
    return s;
  }
}

/** The link GFM would make of the last word of `text` (which ends where the URL ended), if any. */
export function autolinkAtEnd(text: string): FoundLink | null {
  const ws = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\t"), text.lastIndexOf("\n"), text.lastIndexOf("\u00a0"), text.lastIndexOf("<"));
  let start = ws + 1;
  while (start < text.length && LEAD.test(text[start]!)) start++;
  const word = text.slice(start);
  if (!word) return null;

  const url = /^(https?:\/\/|www\.)/i.exec(word);
  if (url) {
    const trimmed = trimAutolink(word);
    const rest = trimmed.slice(url[0].length);
    const domain = /^[\w.-]*/.exec(rest)![0];
    if (!validDomain(domain)) return null;
    const href = url[0].toLowerCase() === "www." ? `http://${trimmed}` : trimmed;
    return { start, end: start + trimmed.length, href };
  }
  // Email: local part, @, a domain with a period; not ending in - or _.
  const email = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(word.replace(/\.+$/, ""));
  if (email && email[0].length === word.replace(/\.+$/, "").length && !/[-_]$/.test(email[0])) {
    return { start, end: start + email[0].length, href: `mailto:${email[0]}` };
  }
  return null;
}

/** Link the URL that ends at `pos` (the caret) in `state`, adding to `tr`. Returns whether it did. */
export function linkUrlBefore(state: EditorState, tr: Transaction, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code) return false;
  const link = state.schema.marks.link;
  if (!link) return false;
  // Atoms count as one character, so offsets match positions.
  const before = parent.textBetween(0, $pos.parentOffset, undefined, "\ufffc");
  const found = autolinkAtEnd(before);
  if (!found) return false;
  const from = $pos.start() + found.start;
  const to = $pos.start() + found.end;
  let blocked = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return true;
    if (!node.isText || node.marks.some((m) => m.type === link || m.type.spec.code)) blocked = true;
    return false;
  });
  if (blocked) return false;
  tr.addMark(from, to, link.create({ href: found.href, ...("form" in (link.spec.attrs ?? {}) ? { form: "literal" } : {}) }));
  return true;
}

/** A space, tab or `<` typed after a URL links it. */
export const autolinkInputPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-autolink"),
      props: {
        handleTextInput(view, from, to, text) {
          if (!/^[\s<]/.test(text) || from !== to) return false;
          const tr = view.state.tr;
          if (!linkUrlBefore(view.state, tr, from)) return false;
          // The typed character goes in unlinked (the link mark ends here).
          tr.insertText(text, from, to);
          tr.removeMark(from, from + text.length, view.state.schema.marks.link!);
          view.dispatch(tr);
          return true;
        },
      },
    }),
);

/**
 * Enter (or Shift+Enter) after a URL links it, then does its usual thing.
 * On the view's own handleKeyDown, ahead of every keymap plugin, so those
 * then act on the linked state.
 */
export function autolinkEnter(ctx: Ctx): void {
  ctx.update(editorViewOptionsCtx, (opts) => {
    const prev = opts.handleKeyDown;
    return {
      ...opts,
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing && view.editable) {
          const { selection } = view.state;
          const tr = view.state.tr;
          if (selection.empty && linkUrlBefore(view.state, tr, selection.from)) view.dispatch(tr);
        }
        return prev?.(view, event) ?? false;
      },
    };
  });
}
