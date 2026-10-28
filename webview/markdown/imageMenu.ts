/**
 * Right-click menu for images: cut or copy the image, add or remove the
 * caption, show the file in the OS file manager or VS Code's Explorer, and
 * delete the image.
 *
 * Cut and Copy go through the editor's own clipboard handling (the image is
 * selected), so pasting gives the same image back, here or in another
 * Markdown document, and other apps get its HTML and Markdown text.
 *
 * The caption belongs to Crepe's image block view, which keeps "is the
 * caption field shown" to itself; the menu flips it with the view's own
 * caption button, so the two never disagree.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { Captions, CaptionsOff, Copy, FolderOpen, FolderSearch, Scissors, Trash2 } from "lucide";

import { openContextMenu, type MenuEntry } from "../contextMenu";

export type RevealTarget = "os" | "explorer";

export interface ImageMenuOptions {
  /** Show an image file (its `src` as written) in the OS file manager or VS Code's Explorer. */
  reveal?: (src: string, where: RevealTarget) => void;
  /** Whether `src` is a file that can be shown (not a web URL). */
  isLocal?: (src: string) => boolean;
}

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
/** The OS file manager's name, as VS Code's own "Reveal in …" uses it. */
export const OS_FILE_MANAGER = /Mac/.test(platform) ? "Finder" : /Win/.test(platform) ? "File Explorer" : "File Manager";

/** The image node a DOM element belongs to, with its position. */
function imageAt(view: EditorView, target: Element): { pos: number; node: ProseNode; dom: Element } | null {
  const dom = target.closest(".milkdown-image-block, .milkdown-image-inline");
  if (!dom || !view.dom.contains(dom)) return null;
  let found: { pos: number; node: ProseNode; dom: Element } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== "image-block" && node.type.name !== "image") return true;
    const nodeDom = view.nodeDOM(pos);
    if (nodeDom === dom || (nodeDom instanceof Element && (nodeDom.contains(dom) || dom.contains(nodeDom)))) found = { pos, node, dom };
    return false;
  });
  return found;
}

/** The image as Markdown, for a clipboard the editor's own copy can't reach. */
function imageMarkdown(node: ProseNode): string {
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "").replace(/[[\]]/g, "\\$&");
  const title = String((node.type.name === "image-block" ? node.attrs.caption : node.attrs.title) ?? "");
  return `![${alt}](${src}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
}

/** Cut or copy the image at `pos`: selected, then the browser's own command, which ProseMirror serializes. */
export function clipboardImage(view: EditorView, pos: number, cut: boolean): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  view.focus();
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  let done = false;
  try {
    done = document.execCommand(cut ? "cut" : "copy");
  } catch {
    done = false;
  }
  if (done) return;
  void navigator.clipboard?.writeText(imageMarkdown(node)).catch(() => undefined);
  if (cut) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
}

/** Show or hide the image block's caption field, through its own caption button. */
function toggleCaptionField(block: Element) {
  const button = block.querySelector(".operation > .operation-item");
  button?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
}

export function imageMenuItems(view: EditorView, at: { pos: number; node: ProseNode; dom: Element }, options: ImageMenuOptions): MenuEntry[] {
  const entries: MenuEntry[] = [
    { label: "Cut", icon: Scissors, onSelect: () => clipboardImage(view, at.pos, true) },
    { label: "Copy", icon: Copy, onSelect: () => clipboardImage(view, at.pos, false) },
    "separator",
  ];
  const src = String(at.node.attrs.src ?? "");
  if (at.node.type.name === "image-block") {
    const shown = !!at.dom.querySelector(".caption-input") || !!at.node.attrs.caption;
    entries.push(
      shown
        ? {
            label: "Remove caption",
            icon: CaptionsOff,
            onSelect: () => {
              if (at.dom.querySelector(".caption-input")) toggleCaptionField(at.dom);
              const node = view.state.doc.nodeAt(at.pos);
              if (node) view.dispatch(view.state.tr.setNodeMarkup(at.pos, undefined, { ...node.attrs, caption: "" }));
            },
          }
        : {
            label: "Add caption",
            icon: Captions,
            onSelect: () => {
              toggleCaptionField(at.dom);
              requestAnimationFrame(() => at.dom.querySelector<HTMLInputElement>(".caption-input")?.focus());
            },
          },
    );
  }
  if (options.reveal) {
    const local = !!src && (options.isLocal?.(src) ?? true);
    if (entries[entries.length - 1] !== "separator") entries.push("separator");
    entries.push(
      { label: `Show in ${OS_FILE_MANAGER}`, icon: FolderOpen, disabled: !local, onSelect: () => options.reveal!(src, "os") },
      {
        label: OS_FILE_MANAGER === "File Explorer" ? "Show in Explorer View" : "Show in Explorer",
        icon: FolderSearch,
        disabled: !local,
        onSelect: () => options.reveal!(src, "explorer"),
      },
    );
  }
  if (entries[entries.length - 1] !== "separator") entries.push("separator");
  entries.push({
    label: "Delete image",
    icon: Trash2,
    danger: true,
    onSelect: () => {
      const node = view.state.doc.nodeAt(at.pos);
      if (!node) return;
      view.dispatch(view.state.tr.delete(at.pos, at.pos + node.nodeSize).scrollIntoView());
      view.focus();
    },
  });
  return entries;
}

/** Right-click on an image opens the image menu (the image is selected first). */
export function imageContextMenu(options: ImageMenuOptions = {}) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey("ken-image-menu"),
        props: {
          handleDOMEvents: {
            contextmenu: (view, event) => {
              if (!view.editable || !(event.target instanceof Element)) return false;
              // The caption field keeps the browser's own menu (cut, copy, paste).
              if (event.target.closest("input")) return false;
              const at = imageAt(view, event.target);
              if (!at) return false;
              event.preventDefault();
              view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.pos)));
              openContextMenu(event.clientX, event.clientY, imageMenuItems(view, at, options));
              return true;
            },
          },
        },
      }),
  );
}
