/**
 * The comments sidebar: every thread in document order, with the text it is
 * about, its messages, a reply box, and Resolve / Delete. Opens when a comment
 * is added, when a highlight is clicked, or from the toolbar.
 */
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Check, MessagesSquare, RotateCcw, Trash2, X, createElement, type IconNode } from "lucide";

import { addCommentRange, activeComment, commentRanges, refreshComments, removeCommentRange } from "./anchors";
import { newId, threadStore, type CommentThread } from "./store";

const icon = (node: IconNode, size = 14) => createElement(node, { width: size, height: size, "stroke-width": 1.75 });

let instance: CommentsPanel | null = null;

/** Add a comment on the selection (or the current block) and start writing it. */
export function addComment(): void {
  instance?.add();
}

export function toggleComments(): void {
  if (!instance) return;
  if (instance.isOpen) instance.close();
  else instance.open(null);
}

export function commentsOpen(): boolean {
  return !!instance?.isOpen;
}

/** Open comments (unresolved, with markers) for the toolbar badge. */
export function openCommentCount(doc: ProseNode): number {
  return commentRanges(doc).filter((r) => {
    const t = threadStore.get(r.id);
    return t && !t.resolved && t.messages.length;
  }).length;
}

function relative(date: string): string {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export class CommentsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private showResolved = false;
  private focusId: string | null = null;
  /** Whether `focusId`'s input should take the keyboard (only for a new comment). */
  private focusInput = false;
  private renderQueued = false;

  constructor(private readonly view: () => EditorView | null) {
    this.el = document.createElement("aside");
    this.el.className = "ken-comments";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Comments");
    const head = document.createElement("header");
    const title = document.createElement("h2");
    title.append(icon(MessagesSquare, 14), document.createTextNode("Comments"));
    const resolved = document.createElement("label");
    resolved.className = "ken-comments-resolved";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      this.showResolved = box.checked;
      this.render();
    });
    resolved.append(box, document.createTextNode("Resolved"));
    const close = this.button(X, "Close comments", () => this.close());
    head.append(title, resolved, close);
    this.list = document.createElement("div");
    this.list.className = "ken-comments-list";
    this.el.append(head, this.list);
    document.body.append(this.el);
    threadStore.onChange(() => this.queueRender());
    instance = this;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /**
   * Show the sidebar, scrolled to a thread if given. `focusInput` moves the
   * keyboard to its input (a new comment); otherwise the caret stays put.
   */
  open(id: string | null, focusInput = false): void {
    this.el.hidden = false;
    document.body.classList.add("comments-open");
    this.focusId = id;
    this.focusInput = focusInput;
    const view = this.view();
    if (view) refreshComments(view, id);
    this.render();
  }

  close(): void {
    this.el.hidden = true;
    document.body.classList.remove("comments-open");
    const view = this.view();
    if (view) refreshComments(view, null);
    this.dropEmpty();
  }

  /** New comment on the selection; its card opens with the input focused. */
  add(): void {
    const view = this.view();
    if (!view) return;
    const id = newId("c", (x) => threadStore.has(x) || commentRanges(view.state.doc).some((r) => r.id === x));
    const tr = addCommentRange(view.state, id);
    if (!tr) return;
    this.dropEmpty();
    threadStore.create(id);
    view.dispatch(tr);
    this.open(id, true);
  }

  /** A thread that never got a message is removed with its markers. */
  private dropEmpty(except?: string) {
    const view = this.view();
    for (const t of threadStore.all()) {
      if (t.messages.length || t.id === except) continue;
      if (view) {
        const tr = removeCommentRange(view.state, t.id);
        if (tr) view.dispatch(tr);
      }
      threadStore.remove(t.id);
    }
  }

  private queueRender() {
    if (this.renderQueued || !this.isOpen) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render(): void {
    const view = this.view();
    if (!view || !this.isOpen) return;
    // Keep what is being typed in a reply box across a re-render.
    const drafts = new Map<string, string>();
    for (const ta of this.list.querySelectorAll<HTMLTextAreaElement>("textarea[data-thread]")) drafts.set(ta.dataset.thread!, ta.value);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.thread;
    this.list.replaceChildren();
    const ranges = commentRanges(view.state.doc);
    const active = activeComment(view.state);
    let shown = 0;
    for (const r of ranges) {
      const thread = threadStore.get(r.id);
      if (!thread) continue;
      if (thread.resolved && !this.showResolved && r.id !== this.focusId) continue;
      const excerpt = view.state.doc
        .textBetween(r.from, r.to, " ", " ▪ ")
        .replace(/\s+/g, " ")
        .replace(/^[\s▪]+|[\s▪]+$/g, "");
      const card = this.card(thread, excerpt, r.from, r.id === active || r.id === this.focusId);
      this.list.append(card);
      shown++;
      const ta = card.querySelector<HTMLTextAreaElement>("textarea");
      if (ta && drafts.has(r.id)) ta.value = drafts.get(r.id)!;
    }
    if (!shown) {
      const empty = document.createElement("p");
      empty.className = "ken-comments-empty";
      empty.textContent = "No comments";
      this.list.append(empty);
    }
    const focusTarget = this.focusId ?? focused;
    if (focusTarget) {
      const card = this.list.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusTarget)}"]`);
      card?.scrollIntoView({ block: "nearest" });
      // A new comment's box, or the box that had focus before this redraw.
      const ta = card?.querySelector<HTMLTextAreaElement>("textarea");
      if (ta && (this.focusInput || (!this.focusId && focused))) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      this.focusId = null;
      this.focusInput = false;
    }
  }

  private card(thread: CommentThread, excerpt: string, from: number, active: boolean): HTMLElement {
    const card = document.createElement("section");
    card.className = "ken-comment-card";
    card.dataset.card = thread.id;
    card.classList.toggle("active", active);
    card.classList.toggle("resolved", thread.resolved);

    const quote = document.createElement("button");
    quote.type = "button";
    quote.className = "ken-comment-quote";
    quote.textContent = excerpt.length > 120 ? `${excerpt.slice(0, 117)}…` : excerpt || "(no text)";
    quote.title = "Go to the commented text";
    quote.addEventListener("click", () => this.reveal(thread.id, from));
    card.append(quote);

    for (const m of thread.messages) {
      const msg = document.createElement("div");
      msg.className = "ken-comment-message";
      const meta = document.createElement("div");
      meta.className = "ken-comment-meta";
      const who = document.createElement("strong");
      who.textContent = m.author || "Someone";
      const when = document.createElement("span");
      when.textContent = relative(m.date);
      when.title = m.date ? new Date(m.date).toLocaleString() : "";
      meta.append(who, when);
      if (thread.messages.length > 1) {
        meta.append(this.button(X, "Delete this reply", () => threadStore.deleteMessage(thread.id, m.id), "ken-comment-delete-msg"));
      }
      const text = document.createElement("div");
      text.className = "ken-comment-text";
      text.textContent = m.text;
      msg.append(meta, text);
      card.append(msg);
    }

    const isNew = thread.messages.length === 0;
    const input = document.createElement("textarea");
    input.className = "ken-comment-input";
    input.dataset.thread = thread.id;
    input.rows = isNew ? 3 : 1;
    input.placeholder = isNew ? "Add a comment…" : "Reply…";
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      threadStore.reply(thread.id, text);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (isNew) this.discard(thread.id);
        else input.blur();
      }
      e.stopPropagation();
    });
    input.addEventListener("focus", () => input.rows < 3 && (input.rows = 3));
    card.append(input);

    const actions = document.createElement("div");
    actions.className = "ken-comment-actions";
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "ken-comment-send";
    primary.textContent = isNew ? "Comment" : "Reply";
    primary.title = "⌘Enter";
    primary.addEventListener("click", send);
    actions.append(primary);
    if (isNew) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ken-comment-cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.discard(thread.id));
      actions.append(cancel);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "ken-comment-spacer";
      actions.append(
        spacer,
        thread.resolved
          ? this.button(RotateCcw, "Reopen", () => threadStore.setResolved(thread.id, false))
          : this.button(Check, "Resolve", () => threadStore.setResolved(thread.id, true)),
        this.button(Trash2, "Delete comment", () => this.discard(thread.id), "danger"),
      );
    }
    card.append(actions);
    card.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button, textarea")) return;
      this.reveal(thread.id, from);
    });
    return card;
  }

  /** Remove a thread and its markers (the commented text stays). */
  private discard(id: string) {
    const view = this.view();
    if (view) {
      const tr = removeCommentRange(view.state, id);
      if (tr) view.dispatch(tr);
    }
    threadStore.remove(id);
  }

  /** Scroll to a comment and put the caret at its start. */
  private reveal(id: string, from: number) {
    const view = this.view();
    if (!view) return;
    const pos = Math.min(from + 1, view.state.doc.content.size);
    const sel = TextSelection.near(view.state.doc.resolve(pos), 1);
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
    refreshComments(view, id);
    view.focus();
    this.render();
  }

  private button(node: IconNode, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ken-comment-button ${cls}`.trim();
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(icon(node));
    b.addEventListener("click", onClick);
    return b;
  }
}
