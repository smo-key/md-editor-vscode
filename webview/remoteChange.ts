import type { Transaction } from "@milkdown/kit/prose/state";

/**
 * Whether every transaction applies someone else's edits in a collaboration
 * session (y-prosemirror marks those under its `y-sync` plugin key). Plugins
 * that normalise the document on change skip them: the other editor already
 * normalised its change, and doing it again here would duplicate the fix.
 */
export function isRemoteChange(trs: readonly Transaction[]): boolean {
  return trs.length > 0 && trs.every((tr) => (tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true);
}
