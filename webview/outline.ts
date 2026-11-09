/**
 * The outline: every heading of the document in a sidebar at the left,
 * indented by level, with the section being read highlighted as the editor
 * scrolls. Toggled from the toolbar; the text column moves right to make room
 * (`body.outline-open`). Clicking a heading puts the caret there and scrolls to it.
 *
 * When the window is too narrow for both, it is a temporary overlay instead
 * (`body.outline-overlay`): the text stays put, and picking a heading, clicking
 * outside it or Escape closes it.
 *
 * Its right edge drags to resize it (double-click: default width).
 *
 * Whether it is open, and its width, are remembered (the host's prefs,
 * `onOutlinePref`): only the user opening or closing it changes the first, not
 * an overlay closing itself, and a remembered outline is reopened only where
 * it fits beside the text.
 */
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { X, createElement } from "lucide";

import type { EditorPrefs } from "../src/protocol";
import { collectHeadings, revealHeading, type HeadingEntry } from "./markdown/anchors";

let instance: OutlinePanel | null = null;

/** Sidebar widths (px): the default, and how narrow or wide it can be dragged. */
export const OUTLINE_WIDTH = 240;
export const OUTLINE_MIN = 160;
export const OUTLINE_MAX = 480;

/** Whether the user last left the outline open. */
let remembered = false;
let width = OUTLINE_WIDTH;
let prefListener: ((prefs: Pick<EditorPrefs, "outline" | "outlineWidth">) => void) | null = null;

export function clampOutlineWidth(w: number): number {
  return Number.isFinite(w) ? Math.round(Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, w))) : OUTLINE_WIDTH;
}

/** The sidebar's width, which the text column's margin follows (styles.css). */
function applyWidth(next: number) {
  width = clampOutlineWidth(next);
  document.documentElement.style.setProperty("--ken-outline-width", `${width}px`);
}

/** The remembered state, from the host: set before the editor is built. */
export function setOutlinePref(prefs: Pick<EditorPrefs, "outline" | "outlineWidth">): void {
  remembered = !!prefs.outline;
  applyWidth(prefs.outlineWidth ?? OUTLINE_WIDTH);
}

/** Called when the user opens, closes or resizes the outline, to save it. */
export function onOutlinePref(listener: (prefs: Pick<EditorPrefs, "outline" | "outlineWidth">) => void): void {
  prefListener = listener;
}

function remember(open: boolean) {
  if (remembered === open) return;
  remembered = open;
  prefListener?.({ outline: open });
}

export function toggleOutline(): void {
  if (!instance) return;
  if (instance.isOpen) instance.close();
  else instance.open();
  remember(instance.isOpen);
}

export function outlineOpen(): boolean {
  return !!instance?.isOpen;
}

const commentsOpen = () => document.body.classList.contains("comments-open");

/** The narrowest text column the outline may leave beside it. */
const MIN_TEXT = 600;
/** The comments sidebar's width (styles.css), when it is open too. */
const COMMENTS_WIDTH = 320;

/** Whether a window this wide only has room for the outline as an overlay. */
export function outlineOverlays(windowWidth: number, commentsOpen: boolean, outlineWidth = width): boolean {
  return windowWidth - (commentsOpen ? COMMENTS_WIDTH : 0) < outlineWidth + MIN_TEXT;
}

/** A heading counts as current once its top is this far into the pane. */
const READING_LINE = 0.25;

/**
 * Index of the heading whose section is being read: the last one at or above
 * the reading line. Scrolled to the very end, the last heading on screen wins,
 * so a short final section can still be reached. -1 above the first heading.
 */
export function currentHeading(tops: number[], paneHeight: number, atEnd: boolean): number {
  const line = atEnd ? paneHeight : Math.max(paneHeight * READING_LINE, 24);
  let current = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) current = i;
    else break;
  }
  return current;
}

export class OutlinePanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private headings: HeadingEntry[] = [];
  private items: HTMLButtonElement[] = [];
  private active = -1;
  private frame = 0;
  private overlay = false;
  private readonly onScroll = () => this.queueActive();
  private readonly onResize = () => {
    this.layout();
    this.queueActive();
  };
  /** Overlay: a press outside it (other than its own toolbar button) closes it. */
  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.overlay || !(e.target instanceof Node)) return;
    if (this.el.contains(e.target)) return;
    if (e.target instanceof Element && e.target.closest('.ken-toolbar-button[data-id="outline"]')) return;
    this.close();
  };
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.overlay || e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  constructor(
    private view: EditorView,
    private readonly scroll: HTMLElement,
    container: HTMLElement = document.body,
  ) {
    this.el = document.createElement("aside");
    this.el.className = "ken-outline";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Outline");
    // Clicking a heading must not take focus from the text.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    this.list = document.createElement("nav");
    this.list.className = "ken-outline-list";
    // Only the overlay has a close button (styles.css); docked, the toolbar button closes it.
    const head = document.createElement("div");
    head.className = "ken-outline-head";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ken-outline-close";
    close.title = "Close outline";
    close.setAttribute("aria-label", "Close outline");
    close.append(createElement(X, { width: 14, height: 14, "stroke-width": 1.75 }));
    close.addEventListener("click", () => this.close());
    head.append(close);
    this.el.append(head, this.list, this.resizeHandle());
    container.append(this.el);
    instance = this;
    // Reopened as the user left it, once the editor is up, if it fits beside the text.
    if (remembered) {
      queueMicrotask(() => {
        if (instance === this && !this.isOpen && !this.view.isDestroyed && !outlineOverlays(window.innerWidth, commentsOpen())) this.open();
      });
    }
  }

  /** The right edge: drag to resize, double-click for the default width, ←/→ from the keyboard. */
  private resizeHandle(): HTMLElement {
    const handle = document.createElement("div");
    handle.className = "ken-outline-resize";
    handle.tabIndex = 0;
    handle.title = "Drag to resize the outline";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize outline");
    const done = () => {
      document.body.classList.remove("ken-outline-resizing");
      this.layout();
      this.queueActive();
      prefListener?.({ outlineWidth: width });
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      document.body.classList.add("ken-outline-resizing");
      const left = this.el.getBoundingClientRect().left;
      const move = (ev: PointerEvent) => applyWidth(ev.clientX - left);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        done();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      applyWidth(OUTLINE_WIDTH);
      done();
    });
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      applyWidth(width + (e.key === "ArrowLeft" ? -16 : 16));
      done();
    });
    return handle;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.el.hidden = false;
    document.body.classList.add("outline-open");
    this.layout();
    this.scroll.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.render();
    this.notify();
  }

  close(notify = true): void {
    this.el.hidden = true;
    document.body.classList.remove("outline-open", "outline-overlay");
    this.overlay = false;
    this.scroll.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    cancelAnimationFrame(this.frame);
    if (notify) this.notify();
  }

  /** Docked beside the text when there is room, else an overlay. */
  private layout() {
    this.overlay = outlineOverlays(window.innerWidth, commentsOpen());
    document.body.classList.toggle("outline-overlay", this.overlay);
  }

  /** The toolbar shows the button's state from the editor's state: nudge it. */
  private notify() {
    if (!this.view.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta("addToHistory", false));
  }

  update(view: EditorView, docChanged: boolean): void {
    this.view = view;
    if (!this.isOpen) return;
    // The comments sidebar opening or closing changes the room left.
    this.layout();
    if (docChanged) this.render();
  }

  private render() {
    const next = collectHeadings(this.view.state.doc);
    const same =
      next.length === this.headings.length &&
      next.every((h, i) => h.text === this.headings[i].text && h.level === this.headings[i].level);
    this.headings = next;
    // Typing in a paragraph only moves positions: keep the DOM.
    if (!same || !this.items.length) this.build();
    this.queueActive();
  }

  private build() {
    this.items = [];
    this.active = -1;
    this.list.replaceChildren();
    if (!this.headings.length) {
      const empty = document.createElement("p");
      empty.className = "ken-outline-empty";
      empty.textContent = "No headings yet.";
      this.list.append(empty);
      return;
    }
    const top = Math.min(...this.headings.map((h) => h.level));
    this.headings.forEach((h, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ken-outline-item";
      b.dataset.level = String(h.level);
      b.style.setProperty("--depth", String(h.level - top));
      if (h.level === top) b.dataset.top = "";
      b.textContent = h.text || "Untitled";
      if (!h.text) b.classList.add("untitled");
      b.title = h.text;
      b.addEventListener("click", () => this.go(i));
      this.items.push(b);
      this.list.append(b);
    });
  }

  private go(index: number) {
    const h = this.headings[index];
    if (!h) return;
    const view = this.view;
    const end = h.pos + h.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    revealHeading(view, h.pos);
    view.focus();
    // An overlay was only there to pick a heading.
    if (this.overlay) this.close();
  }

  private queueActive() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.updateActive());
  }

  private updateActive() {
    if (!this.isOpen) return;
    const pane = this.scroll.getBoundingClientRect();
    const tops = this.headings.map((h) => {
      const dom = this.view.nodeDOM(h.pos);
      return dom instanceof HTMLElement ? dom.getBoundingClientRect().top - pane.top : Infinity;
    });
    const atEnd = this.scroll.scrollTop > 0 && this.scroll.scrollTop + this.scroll.clientHeight >= this.scroll.scrollHeight - 2;
    const next = currentHeading(tops, this.scroll.clientHeight, atEnd);
    if (next === this.active) return;
    this.items[this.active]?.classList.remove("active");
    this.items[this.active]?.removeAttribute("aria-current");
    this.active = next;
    const item = this.items[next];
    if (!item) return;
    item.classList.add("active");
    item.setAttribute("aria-current", "location");
    item.scrollIntoView({ block: "nearest" });
  }

  destroy() {
    this.close(false);
    this.el.remove();
    if (instance === this) instance = null;
  }
}

/** Mounts the outline for the editor scrolled inside `scroll`. */
export function outlinePlugin(scroll: HTMLElement, container?: HTMLElement) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey("ken-outline"),
        view: (view) => {
          const panel = new OutlinePanel(view, scroll, container);
          return {
            update: (v, prev) => panel.update(v, !v.state.doc.eq(prev.doc)),
            destroy: () => panel.destroy(),
          };
        },
      }),
  );
}
