/**
 * Tab in a plain paragraph types a real tab character.
 *
 * Crepe answers Tab outside lists, tables, headings and code with Milkdown's
 * indent plugin, configured for four spaces; here it inserts `\t` instead.
 * The tab is drawn `editor.tabSize` wide (CSS `tab-size`, set from the host's
 * config in main.ts).
 *
 * On disk a tab inside a line is written as is. A tab that starts or ends a
 * line is written `&#x9;`: raw, a leading tab would reopen as an indented code
 * block and a trailing one would be dropped as trailing whitespace.
 * remark-stringify already encodes those, but Milkdown's own `text` handler
 * returns any text that ends in whitespace verbatim, skipping that; so text
 * with a tab at either end goes through remark's escaping here.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { indentConfig } from "@milkdown/kit/plugin/indent";
import type { Handle } from "mdast-util-to-markdown";

/** A tab at the start or end of a text run (`\t` in the middle stays raw). */
const EDGE_TAB = /^\t|\t$/;

export function configureTabIndent(ctx: Ctx): void {
  ctx.update(indentConfig.key, (value) => ({ ...value, type: "tab" as const }));
  ctx.update(remarkStringifyOptionsCtx, (opts) => {
    const base = opts.handlers?.text as Handle | undefined;
    const text: Handle = (node, parent, state, info) => {
      if (EDGE_TAB.test(node.value)) return state.safe(node.value, { ...info, encode: [] });
      return base ? base(node, parent, state, info) : state.safe(node.value, info);
    };
    return { ...opts, handlers: { ...opts.handlers, text } };
  });
}
