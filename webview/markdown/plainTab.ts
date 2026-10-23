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
 * returns any text that ends in whitespace verbatim, skipping that. So the
 * text still goes through the handler this wraps (and so through every other
 * text escape, such as the `$` one in mathSyntax.ts, whatever the order they
 * were registered in), and only an edge tab it left raw is then encoded the
 * way remark would.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { indentConfig } from "@milkdown/kit/plugin/indent";
import type { Handle } from "mdast-util-to-markdown";

type Info = Parameters<Handle>[3];

/**
 * `out` (what the wrapped handler wrote for `value`) with a raw leading or
 * trailing run of tabs encoded as remark encodes it in context.
 */
function encodeEdgeTabs(value: string, out: string, state: Parameters<Handle>[2], info: Info): string {
  const lead = /^\t+/.exec(value)?.[0] ?? "";
  if (lead.length === value.length) return state.safe(value, { ...info, encode: [] });
  const trail = /\t+$/.exec(value)?.[0] ?? "";
  if (lead && out.startsWith(lead)) {
    const safe = state.safe(lead, { before: info.before, after: value.charAt(lead.length), encode: [] });
    out = safe + out.slice(lead.length);
  }
  if (trail && out.endsWith(trail)) {
    const before = value.charAt(value.length - trail.length - 1);
    const safe = state.safe(trail, { before, after: info.after, encode: [] });
    out = out.slice(0, out.length - trail.length) + safe;
  }
  return out;
}

export function configureTabIndent(ctx: Ctx): void {
  ctx.update(indentConfig.key, (value) => ({ ...value, type: "tab" as const }));
  ctx.update(remarkStringifyOptionsCtx, (opts) => {
    const base = opts.handlers?.text as Handle | undefined;
    const text: Handle = (node, parent, state, info) => {
      const out = base ? base(node, parent, state, info) : state.safe(node.value, info);
      return /^\t|\t$/.test(node.value) ? encodeEdgeTabs(node.value, out, state, info) : out;
    };
    return { ...opts, handlers: { ...opts.handlers, text } };
  });
}
