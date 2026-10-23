/**
 * Keeps every link in the form it was written. mdast-util-to-markdown writes
 * a link whose text is its URL as `<url>`, so a bare `https://…` (a GFM
 * autolink literal) and `[url](url)` both came back as `<https://…>` after
 * any unrelated edit, putting a diff on a line nobody touched.
 *
 * - On parse, a remark plugin reads the source character each `link` starts
 *   at: `<` is an autolink, `[` an inline link, anything else a literal. It
 *   stores that as `data.kenForm`, and the `link` mark keeps it in a `form`
 *   attribute.
 * - On save, a literal is written back bare when its text is still exactly
 *   what the URL was written as and its neighbours can't change how it
 *   parses; otherwise it falls back to the default (`<url>`). An inline link
 *   is always written `[text](url)`, even when its text is its URL.
 *
 * Links made in the editor have no form (`null`) and serialize as before.
 */
import type { Mark, MarkType } from "@milkdown/kit/prose/model";
import { linkSchema } from "@milkdown/kit/preset/commonmark";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

export type LinkForm = "literal" | "autolink" | "inline";

const FORMS: readonly LinkForm[] = ["literal", "autolink", "inline"];
const asForm = (v: unknown): LinkForm | null => (FORMS.includes(v as LinkForm) ? (v as LinkForm) : null);

interface MdNode {
  type: string;
  url?: string;
  title?: string | null;
  value?: string;
  kenForm?: unknown;
  data?: { kenForm?: unknown };
  position?: { start?: { offset?: number } };
  children?: MdNode[];
}

/** The form of a parsed `link`, from the character it starts at. */
export function formAt(source: string, node: MdNode): LinkForm {
  const offset = node.position?.start?.offset;
  // GFM autolink literals found by mdast-util-gfm-autolink-literal's
  // transform have no position; nothing else makes positionless links.
  if (typeof offset !== "number") return "literal";
  const ch = source.charAt(offset);
  return ch === "<" ? "autolink" : ch === "[" ? "inline" : "literal";
}

function markForms(node: MdNode, source: string): void {
  if (node.type === "link") node.data = { ...(node.data ?? {}), kenForm: formAt(source, node) };
  for (const child of node.children ?? []) markForms(child, source);
}

/** The text a literal shows, if `url` is what a GFM literal of that text links to. */
function literalText(node: MdNode): string | null {
  const only = node.children?.length === 1 ? node.children[0] : undefined;
  if (!only || only.type !== "text" || !only.value || node.title) return null;
  const text = only.value;
  const url = node.url ?? "";
  if (/[\s<>]/.test(text)) return null;
  if (text === url && /^https?:\/\//i.test(url)) return text;
  if (/^www\./i.test(text) && url === `http://${text}`) return text;
  if (text.includes("@") && url === `mailto:${text}`) return text;
  return null;
}

// Where GFM (micromark) starts and ends a literal, kept to the cases checked
// in gfm.test.ts. A `www.` literal starts only at the start of a line or
// after whitespace, `(`, `*`, `_`, `~`, `[` or `]`; `http(s)://` and email
// literals also after a quote. A literal ends before trailing punctuation,
// quotes, `]` and an unbalanced `)`.
const SAFE_BEFORE_WWW = /^(|\s|[(*_~[\]])$/;
const SAFE_BEFORE = /^(|\s|[(*_~[\]'"])$/;
const SAFE_AFTER = /^(|\s|[.,:;!?)\]'"*_~])$/;

/** Whether a literal can be written bare between `before` and `after`. */
function safeAround(text: string, before: string, after: string, state: ToMarkdownState): boolean {
  // A table cell's pipes are split off before its content is parsed.
  const cell = state.stack.includes("tableCell");
  const b = before.slice(-1);
  const a = after.charAt(0);
  // `&name;` after a literal is read as an entity and taken off its end.
  if (a === ";" && /&[a-z0-9]+$/i.test(text)) return false;
  const beforeOk = /^www\./i.test(text) ? SAFE_BEFORE_WWW : SAFE_BEFORE;
  return (beforeOk.test(b) || (cell && b === "|")) && (SAFE_AFTER.test(a) || (cell && a === "|"));
}

interface Info {
  before: string;
  after: string;
}

type Handle = (node: MdNode, parent: unknown, state: ToMarkdownState, info: Info) => string;

interface ToMarkdownState {
  options: { resourceLink?: boolean };
  stack: string[];
}

const defaultLink = defaultHandlers.link as unknown as Handle & { peek: Handle };

const formOf = (node: MdNode) => asForm(node.kenForm ?? node.data?.kenForm);

/** Write the link back as the form it was read in, when that is still safe. */
export const linkHandler: Handle & { peek: Handle } = Object.assign(
  (node: MdNode, parent: unknown, state: ToMarkdownState, info: Info): string => {
    const form = formOf(node);
    if (form === "literal") {
      const text = literalText(node);
      if (text !== null && safeAround(text, info.before, info.after, state)) return text;
    }
    if (form === "inline") {
      const prev = state.options.resourceLink;
      state.options.resourceLink = true;
      try {
        return defaultLink(node, parent, state, info);
      } finally {
        state.options.resourceLink = prev;
      }
    }
    return defaultLink(node, parent, state, info);
  },
  {
    // What the previous sibling sees next to it: `[` must be known (so a `!`
    // before it is escaped and can't make an image); otherwise the default.
    peek: (node: MdNode, parent: unknown, state: ToMarkdownState, info: Info): string =>
      formOf(node) === "inline" ? "[" : defaultLink.peek(node, parent, state, info),
  },
);

interface RemarkProcessor {
  data: () => Record<string, unknown>;
}

function remarkLinkForm(this: RemarkProcessor) {
  const data = this.data();
  const extensions = (data.toMarkdownExtensions ??= []) as unknown[];
  extensions.push({ handlers: { link: linkHandler } });
  return (tree: MdNode, file: unknown) => markForms(tree, String(file ?? ""));
}

export const remarkLinkFormPlugin = $remark("kenLinkForm", () => remarkLinkForm as never);

/** The commonmark `link` mark, plus the form it was written in. */
export const linkFormSchema = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), form: { default: null, validate: "string|null" } },
    // The form rides along as `data-ken-form` (not as an `<a form>`), so a
    // link copied and pasted inside the editor keeps it.
    parseDOM: (base.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (dom: HTMLElement | string) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom as never) : {};
        if (attrs === false || attrs === null || typeof dom === "string") return attrs;
        return { ...(attrs ?? {}), form: asForm(dom.getAttribute("data-ken-form")) };
      },
    })),
    toDOM: (mark: Mark) => {
      const { form, ...attrs } = mark.attrs;
      const plain = { ...mark, attrs } as unknown as Mark;
      const [tag, domAttrs, ...rest] = base.toDOM!(plain, true) as [string, Record<string, unknown>, ...unknown[]];
      const { form: _drop, ...clean } = domAttrs;
      return [tag, { ...clean, ...(form ? { "data-ken-form": form } : {}) }, ...rest] as never;
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, markType: MarkType) => {
        const form = asForm((node.data as MdNode["data"])?.kenForm);
        state.openMark(markType, { href: node.url as string, title: node.title as string, form });
        state.next(node.children);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, mark: Mark) => {
        state.withMark(mark, "link", undefined, {
          title: mark.attrs.title,
          url: mark.attrs.href,
          ...(mark.attrs.form ? { kenForm: mark.attrs.form } : {}),
        });
      },
    },
  };
});

export const linkFidelityPlugins = [remarkLinkFormPlugin, linkFormSchema].flat();
