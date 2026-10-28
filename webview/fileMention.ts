/**
 * The @ menu: typing "@" at the start of a line or after a space opens a list
 * of the project's files, filtered by name as you keep typing; picking one
 * inserts a link to it by its path relative to this document. Nothing is
 * copied. The host searches (src/fileSearch.ts): only files in the open
 * workspace, without excluded, ignored and dependency folders.
 */
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { createElement, File, FileImage, FileText } from "lucide";

import { encodeHref } from "./markdown/attachments";
import type { FileHit } from "../src/protocol";

export type { FileHit };

export interface FileMentionOptions {
  search: (query: string) => Promise<FileHit[]>;
}

export interface MentionMatch {
  /** Position of the "@". */
  from: number;
  to: number;
  query: string;
}

// Not after a letter or digit: `name@example.com` is an email, not a mention.
const TRIGGER = /(?:^|[\s(\[{"'])@([^\s@]{0,80})$/u;

/** The @ query the caret is in, if any. */
export function mentionMatch(state: EditorState): MentionMatch | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if (($from.marks() ?? []).some((m) => m.type.spec.code || m.type.name === "link")) return null;
  const before = parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const m = TRIGGER.exec(before);
  if (!m) return null;
  return { from: $from.pos - m[1]!.length - 1, to: $from.pos, query: m[1]! };
}

/** Replace the "@query" text with a link to `hit`. */
export function insertFileLink(view: EditorView, match: MentionMatch, hit: FileHit): void {
  const { state } = view;
  const link = state.schema.marks.link;
  if (!link) return;
  const text = hit.name;
  const tr = state.tr.replaceWith(match.from, match.to, state.schema.text(text, [link.create({ href: encodeHref(hit.path) })]));
  // What is typed next is not part of the link.
  tr.setSelection(TextSelection.create(tr.doc, match.from + text.length)).setStoredMarks([]);
  view.dispatch(tr.scrollIntoView());
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
const TEXT = /\.(md|markdown|txt|rst|adoc)$/i;

const key = new PluginKey("ken-file-mention");

class MentionMenuView {
  private readonly el: HTMLElement;
  private items: FileHit[] = [];
  private index = 0;
  private match: MentionMatch | null = null;
  private dismissed: number | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastQuery: string | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly options: FileMentionOptions,
  ) {
    this.el = document.createElement("div");
    this.el.className = "ken-slash-menu ken-mention-menu";
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", "Link to a file");
    this.el.hidden = true;
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(this.el);
    view.dom.addEventListener("blur", this.onBlur);
    this.update(view);
  }

  private readonly onBlur = () => this.hide();

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  update(view: EditorView) {
    const match = view.editable ? mentionMatch(view.state) : null;
    if (!match || match.from === this.dismissed) {
      if (!match) this.dismissed = null;
      this.hide();
      return;
    }
    const sameQuery = this.match && this.match.from === match.from && this.match.query === match.query;
    this.match = match;
    if (this.isOpen) this.position();
    if (sameQuery && this.lastQuery === match.query) return;
    this.lastQuery = match.query;
    // Ask the host, a moment after the last keystroke.
    clearTimeout(this.timer);
    const seq = ++this.seq;
    this.timer = setTimeout(() => {
      void this.options.search(match.query).then((hits) => {
        if (seq !== this.seq || !this.match) return;
        this.items = hits;
        this.index = 0;
        this.render();
      });
    }, 60);
  }

  private render() {
    this.el.replaceChildren();
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "ken-slash-empty";
      empty.textContent = this.match?.query ? "No matching files" : "No files in this workspace";
      this.el.append(empty);
    }
    this.items.forEach((hit, i) => {
      const row = document.createElement("div");
      row.className = "ken-slash-item";
      row.setAttribute("role", "option");
      row.title = hit.path;
      const icon = createElement(IMAGE.test(hit.name) ? FileImage : TEXT.test(hit.name) ? FileText : File, {
        width: 14,
        height: 14,
        "stroke-width": 1.75,
      });
      icon.classList.add("ken-slash-icon");
      const label = document.createElement("span");
      label.className = "ken-slash-label";
      label.textContent = hit.name;
      row.append(icon, label);
      if (hit.dir) {
        const dir = document.createElement("span");
        dir.className = "ken-slash-hint ken-mention-dir";
        dir.textContent = hit.dir;
        row.append(dir);
      }
      row.addEventListener("mousemove", () => {
        if (this.index !== i) this.select(i);
      });
      row.addEventListener("click", () => this.choose(i));
      this.el.append(row);
    });
    this.el.hidden = false;
    this.select(this.index);
    this.position();
  }

  private select(i: number) {
    this.index = i;
    const rows = this.el.querySelectorAll<HTMLElement>(".ken-slash-item");
    rows.forEach((row, j) => row.classList.toggle("active", j === i));
    rows[i]?.scrollIntoView({ block: "nearest" });
  }

  private position() {
    if (!this.match) return;
    const coords = this.view.coordsAtPos(this.match.from);
    const menu = this.el.getBoundingClientRect();
    const toolbar = document.querySelector(".ken-toolbar")?.getBoundingClientRect();
    const atTop = document.body.dataset.toolbar === "top";
    const floor = (toolbar && !atTop && toolbar.height ? toolbar.top : window.innerHeight) - 4;
    const ceiling = (toolbar && atTop && toolbar.height ? toolbar.bottom : 0) + 4;
    const below = coords.bottom + 4;
    const top = below + menu.height <= floor ? below : Math.max(ceiling, coords.top - menu.height - 4);
    const left = Math.max(4, Math.min(coords.left, window.innerWidth - menu.width - 4));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  private choose(i: number) {
    const hit = this.items[i];
    const match = this.match;
    if (!hit || !match) return;
    this.hide();
    insertFileLink(this.view, match, hit);
  }

  hide() {
    clearTimeout(this.timer);
    this.seq++;
    this.el.hidden = true;
    this.match = null;
    this.lastQuery = null;
  }

  keydown(event: KeyboardEvent): boolean {
    if (!this.isOpen || event.isComposing) return false;
    const n = this.items.length;
    switch (event.key) {
      case "ArrowDown":
        if (n) this.select((this.index + 1) % n);
        return true;
      case "ArrowUp":
        if (n) this.select((this.index - 1 + n) % n);
        return true;
      case "Enter":
      case "Tab":
        if (!n) return false;
        this.choose(this.index);
        return true;
      case "Escape":
        this.dismissed = this.match?.from ?? null;
        this.hide();
        return true;
      default:
        return false;
    }
  }

  destroy() {
    this.hide();
    this.view.dom.removeEventListener("blur", this.onBlur);
    this.el.remove();
  }
}

export function fileMentionPlugin(options: FileMentionOptions) {
  return $prose(() => {
    let menu: MentionMenuView | null = null;
    return new Plugin({
      key,
      view: (view) => {
        menu = new MentionMenuView(view, options);
        return menu;
      },
      props: {
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (!menu?.keydown(event)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    });
  });
}
