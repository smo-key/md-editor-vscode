// DOM pieces shared by the diff view (diff.ts) and a chat agent's pending
// edits in the editor (agentEdits.ts).
import type { DOMSerializer } from "@milkdown/kit/prose/model";
import type { RemovedWidget } from "./diffModel";

/** Wrap the text between offsets `[from, to)` of `root`'s text in spans of `className`. */
function highlightText(root: HTMLElement, ranges: [number, number][], className: string) {
  if (!ranges.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  let offset = 0;
  for (const text of texts) {
    const start = offset;
    const end = offset + text.data.length;
    offset = end;
    const hits = ranges.filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]);
    for (const [a, b] of hits.reverse()) {
      const target = text.splitText(a);
      target.splitText(b - a);
      const span = document.createElement("span");
      span.className = className;
      target.replaceWith(span);
      span.append(target);
    }
  }
}

/** A removed block, drawn as it was (not editable), its removed words marked. */
export function removedBlock(serializer: DOMSerializer, w: RemovedWidget): HTMLElement {
  const box = document.createElement("div");
  box.className = `ken-diff-removed ken-diff-widget${w.entry.pair ? " ken-diff-edited" : ""}`;
  box.contentEditable = "false";
  const dom = serializer.serializeNode(w.entry.node);
  // A table of contents looks as it does in the editor (its class comes from a decoration there).
  if (w.entry.node.type.name === "bullet_list" && w.entry.node.attrs.toc === true && dom instanceof HTMLElement) dom.classList.add("ken-toc");
  box.append(dom);
  highlightText(box, w.words, "ken-diff-removed-text");
  return box;
}
