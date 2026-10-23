// The editor webview: the Crepe-based Markdown editor, bound to a VS Code
// TextDocument through postMessage. VS Code owns the file (save, autosave,
// dirty state, backups); this side only ever reports the edited Markdown.
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import { undo } from "@milkdown/kit/prose/history";

import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import type { LinkClick } from "./markdown/wikiLinks";
import { buildEditor } from "./editorSetup";
import { carriesFiles, handleFileDrop, type FileDropOptions } from "./fileDrop";
import { normalizeTrailingNewlines } from "./markdown/gfmFidelity";
import {
  attachmentName,
  docDir,
  encodeHref,
  isImageFile,
  isImagePath,
  relativeTo,
  resolveSrc,
  type AttachmentAdapter,
} from "./markdown/attachments";
import { closeLightbox, showLightbox } from "./lightbox";
import { initDrawio, versionOf } from "./drawio";
import { FrontmatterPanel } from "./frontmatter";
import { threadStore, splitThreads, formatThreads, type CommentThread } from "./comments/store";
import { Collab, sharedHistory } from "./collab";
import { Presence } from "./presence";
import { commentIds, refreshComments } from "./comments/anchors";
import { CommentsPanel } from "./comments/panel";
import { joinDocument, splitDocument } from "./frontmatterModel";
import { installKeyRouting } from "./keys";
import { onLastHeadingLevel, setLastHeadingLevel } from "./headingControl";
import { command, execute, setShortcutLabels } from "./commands";
import { closeShortcutsPanel, initShortcutsPanel, isShortcutsPanelOpen, toggleShortcutsPanel } from "./shortcutsPanel";
import type { EditorConfig, HostMessage, TestAction, WebviewMessage } from "../src/protocol";
import "@milkdown/crepe/theme/common/style.css";
import "katex/dist/katex.min.css";
import "@milkdown/crepe/theme/frame.css";
import "./markdown/githubAlert.css";
import "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewMessage) => vscode.postMessage(message);

const scroll = document.getElementById("scroll") as HTMLDivElement;
const host = document.getElementById("editor") as HTMLDivElement;
const toolbarHost = document.getElementById("toolbar") as HTMLDivElement;

// Comment threads live in a block at the end of the file (comments/store.ts):
// set aside like the frontmatter, and written back with only the threads
// whose markers are still in the document.
let lastBack = "";
let loadingThreads = false;
function threadsBlock(): string {
  if (!view) return lastBack;
  return threadStore.format(commentIds(view.state.doc));
}
threadStore.onChange(() => {
  if (loadingThreads) return;
  if (view) refreshComments(view);
  collab?.setThreads(sharedThreads());
  dirty = true;
  sync();
});

/** The threads to share in a collaboration session (drafts stay local until posted). */
function sharedThreads(): string[] {
  return threadStore
    .all()
    .filter((t) => t.messages.length > 0)
    .map((t) => JSON.stringify(t));
}

/** Load threads without that counting as an edit here; keeps local drafts. */
function loadThreads(block: string) {
  const drafts = threadStore.all().filter((t) => t.messages.length === 0);
  loadingThreads = true;
  try {
    threadStore.load(block);
    for (const d of drafts) if (!threadStore.has(d.id)) threadStore.create(d.id);
  } finally {
    loadingThreads = false;
  }
}

// Frontmatter is set aside from the editor and shown as a properties panel
// above it (frontmatter.ts); its edits are saved with the document's.
const frontmatterPanel = new FrontmatterPanel(
  // The text column (#editor is `.measure`), before the editor itself.
  host,
  (next) => {
    front = next;
    // Removing the properties takes the blank lines that followed them too.
    if (!next) gap = "";
    collab?.setFront(next);
    dirty = true;
    sync();
  },
);

let crepe: Crepe | undefined;
let commentsPanel: CommentsPanel | null = null;
let view: EditorView | null = null;
let docPath = "README.md";
/** The full document text (frontmatter included) the editor last agreed with the host on. */
let lastText = "";
/** Serialized body Markdown for the current state; a change from it is a user edit. */
let lastSerialized = "";
/** Frontmatter is set aside and put back on every save (the editor would mangle it). */
let front = "";
/** The blank lines between the frontmatter and the body, kept exactly (the editor drops them). */
let gap = "";
/** The frontmatter as last written, so a properties-only edit is still saved. */
let lastFront = "";

// --- Collaboration ---------------------------------------------------------------
// While a session is on, the document is shared live (collab.ts). One editor
// per copy of the file writes it (the hub elects it); the others only follow.

let collab: Collab | null = null;
/** Whether this editor writes its changes to the file (always, outside a session). */
let writer = true;
const presence = new Presence();
let editorCreated!: () => void;
const created = new Promise<void>((resolve) => (editorCreated = resolve));
let collabChain: Promise<void> = Promise.resolve();

function startCollab(m: Extract<HostMessage, { type: "collabStart" }>) {
  if (!view) return;
  collab?.stop();
  // Pending keystrokes belong to the file as it was.
  dirty = true;
  sync();
  // Until the hub says otherwise, someone else may be writing the file.
  writer = false;
  collab = new Collab(
    view,
    {
      send: (data) => post({ type: "collabUpdate", data }),
      sendAwareness: (data) => post({ type: "collabAwareness", data }),
      onFront: (next) => {
        if (next === front) return;
        front = next;
        if (!next) gap = "";
        frontmatterPanel.set(next);
        dirty = true;
        scheduleSync();
      },
      onThreads: (list) => {
        const threads: CommentThread[] = [];
        for (const json of list) {
          try {
            threads.push(JSON.parse(json) as CommentThread);
          } catch {
            // Skipped.
          }
        }
        loadThreads(formatThreads(threads));
        if (view) refreshComments(view);
        dirty = true;
        scheduleSync();
      },
      onPeople: (people) => presence.show(people),
    },
    m.name || threadStore.author || "Someone",
  );
  collab.start(m.seed, m.state, m.awareness, front, sharedThreads());
  document.body.classList.add("collab");
}

function stopCollab() {
  if (!collab) return;
  const wrote = writer;
  collab.stop();
  collab = null;
  writer = true;
  presence.hide();
  document.body.classList.remove("collab");
  if (wrote) {
    dirty = true;
    sync();
  }
  post({ type: "collabStopped", writer: wrote });
}

/** Became (or stopped being) the editor that writes the file. */
function setWriter(next: boolean) {
  writer = next;
  if (!next) return;
  // Write what the shared document says now, even if this editor saw it before.
  lastText = "\u0000";
  lastSerialized = "\u0000";
  dirty = true;
  sync();
}

function onCollabMessage(m: HostMessage) {
  switch (m.type) {
    case "collabStart":
      startCollab(m);
      return;
    case "collabUpdate":
      collab?.apply(m.data);
      return;
    case "collabAwareness":
      collab?.applyAwareness(m.data);
      return;
    case "collabWriter":
      if (collab) setWriter(m.writer);
      return;
    case "collabStop":
      stopCollab();
      return;
  }
}
// The serializer escapes `[` in text, turning every [[wiki link]] into \[\[text]]: put them back.
const unescapeWikiLinks = (md: string) => md.replace(/\\\[\\\[([^\n]+?)\\?\]\\?\]/g, "[[$1]]");

// --- Settings ----------------------------------------------------------------

function applyConfig(config: EditorConfig) {
  const root = document.documentElement.style;
  // An empty setting falls back to the stylesheet's default (the bundled fonts).
  const font = (prop: string, value: string) => (value.trim() ? root.setProperty(prop, value) : root.removeProperty(prop));
  font("--font-sans", config.bodyFontFamily ?? "");
  font("--font-serif", config.headingFontFamily ?? "");
  font("--font-mono", config.codeFontFamily ?? "");
  font("--font-quote", config.quoteFontFamily ?? "");
  root.setProperty("--md-font-size", `${config.fontSize}px`);
  root.setProperty("--md-line-height", String(config.lineHeight));
  root.setProperty("--md-max-width", `${config.maxWidth}px`);
  const position = config.toolbar === "bottom" || config.toolbar === "hidden" ? config.toolbar : "top";
  document.body.dataset.toolbar = position;
  frontmatterPanel.setAlwaysShow(config.alwaysShowProperties === true);
}

// --- Request/response with the host --------------------------------------------

let seq = 0;
const waiting = new Map<number, (m: HostMessage) => void>();
function request<T extends HostMessage>(build: (id: number) => WebviewMessage): Promise<T> {
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve as (m: HostMessage) => void);
    post(build(id));
  });
}

// --- Attachments -----------------------------------------------------------------
// Pasted or dropped files are written beside the document by the host and
// linked with a relative path, so the .md stays portable.

const attachments: AttachmentAdapter = {
  async save(file, sourceName) {
    const data = new Uint8Array(await file.arrayBuffer());
    const reply = await request<Extract<HostMessage, { type: "attachmentSaved" }>>((id) => ({
      type: "saveAttachment",
      id,
      name: file.name,
      data,
      image: isImageFile(file),
      sourceName,
    }));
    if (!reply.path) throw new Error(reply.error ?? "save failed");
    return reply.path;
  },
  async resolve(target) {
    const reply = await request<Extract<HostMessage, { type: "resolved" }>>((id) => ({
      type: "resolve",
      id,
      path: target,
    }));
    if (!reply.url) throw new Error(`cannot resolve ${target}`);
    return reply.url;
  },
};

async function saveBeside(file: File) {
  const name = attachmentName(file, docPath, new Date());
  const named = name === file.name ? file : new File([file], name, { type: file.type });
  // A real file (not clipboard image bytes) may already be in the workspace: the host links it then.
  const saved = await attachments.save(named, name === file.name ? file.name : undefined);
  return { saved, href: encodeHref(relativeTo(docDir(docPath), saved)) };
}

const fileDrop: FileDropOptions = {
  async save(file) {
    try {
      const { saved, href } = await saveBeside(file);
      return { href, name: saved.slice(saved.lastIndexOf("/") + 1), image: isImageFile(file) };
    } catch (err) {
      post({ type: "error", message: `attachment: ${err}` });
      return undefined;
    }
  },
  async link(uris) {
    const reply = await request<Extract<HostMessage, { type: "linkedUris" }>>((id) => ({ type: "linkUris", id, uris }));
    return reply.items.map((item) => ({
      href: item.relative ? encodeHref(item.path) : item.path,
      name: item.name,
      image: isImagePath(item.name),
    }));
  },
};

async function uploadFromImageBlock(file: File): Promise<string> {
  return (await saveBeside(file)).href;
}

const resolved = new Map<string, string>();
/** A document-relative image src becomes a webview URL; anything else passes through. */
function proxyImageSrc(src: string): string | Promise<string> {
  const target = resolveSrc(docPath, src);
  if (!target) return src;
  const hit = resolved.get(target);
  if (hit) return versionOf(target) ? `${hit}?v=${versionOf(target)}` : hit;
  return Promise.resolve()
    .then(() => attachments.resolve(target))
    .then((url) => {
      resolved.set(target, url);
      return url;
    })
    // A diagram saved since it was first shown: load the new file.
    .then((url) => (versionOf(target) ? `${url}?v=${versionOf(target)}` : url))
    .catch(() => src);
}

// draw.io diagrams: files read, written and created by the host, by
// root-relative path (see drawio.ts).
initDrawio({
  pathOf: (src) => resolveSrc(docPath, src),
  async readFile(path) {
    const r = await request<Extract<HostMessage, { type: "fileRead" }>>((id) => ({ type: "readFile", id, path }));
    if (!r.data) throw new Error(r.error ?? "read failed");
    return r.data;
  },
  async writeFile(path, data) {
    const r = await request<Extract<HostMessage, { type: "fileWritten" }>>((id) => ({ type: "writeFile", id, path, data }));
    if (r.error) throw new Error(r.error);
  },
  async createDiagram() {
    const r = await request<Extract<HostMessage, { type: "diagramCreated" }>>((id) => ({ type: "createDiagram", id }));
    if (!r.path) throw new Error(r.error ?? "could not create the diagram");
    return r.path;
  },
  hrefFor: (path) => encodeHref(relativeTo(docDir(docPath), path)),
  openInVsCode: (path) => post({ type: "openFile", path }),
});

// Files dropped in the margins, outside ProseMirror's own element (drops on
// the text are handled by fileDrop.ts before they get here).
scroll.addEventListener("dragover", (e) => {
  if (!carriesFiles(e.dataTransfer) || !view) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  scroll.classList.add("file-drop");
});
scroll.addEventListener("dragleave", (e) => {
  if (!scroll.contains(e.relatedTarget as Node | null)) scroll.classList.remove("file-drop");
});
scroll.addEventListener("drop", (e) => {
  scroll.classList.remove("file-drop");
  if (e.defaultPrevented || !view) return;
  handleFileDrop(view, e, fileDrop);
});

// --- Lightbox ----------------------------------------------------------------------

let pointerStart: { x: number; y: number } | null = null;
scroll.addEventListener("pointerdown", (e) => {
  pointerStart = { x: e.clientX, y: e.clientY };
});
scroll.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  // Shift+click extends the selection (markdown/blockSelection.ts).
  if (event.shiftKey) return;
  if (pointerStart && (Math.abs(event.clientX - pointerStart.x) > 4 || Math.abs(event.clientY - pointerStart.y) > 4)) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("button, input, .image-resize-handle, .operation")) return;
  const svg = target.closest(".mermaid-preview")?.querySelector("svg");
  if (svg) {
    event.preventDefault();
    showLightbox({ kind: "svg", svg: svg.outerHTML });
    return;
  }
  const block = target.closest(".milkdown-image-block, .image-wrapper");
  const image = target instanceof HTMLImageElement ? target : block?.querySelector("img");
  if (image instanceof HTMLImageElement && (image.currentSrc || image.src)) {
    event.preventDefault();
    showLightbox({ kind: "img", src: image.currentSrc || image.src, alt: image.alt });
  }
});

// --- Editor ------------------------------------------------------------------------

function openLink(link: LinkClick): boolean {
  if (link.kind === "wiki") post({ type: "openWikiLink", target: link.target });
  else if (link.kind === "href") post({ type: "openLink", href: link.href });
  else return false;
  return true;
}

// --- Change reporting ---------------------------------------------------------------
// Every document change schedules a sync; the host can also ask for one right
// before VS Code saves, so the last keystroke always makes it to disk.

const SYNC_DELAY_MS = 120;
let dirty = false;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while the host's own text is being applied, which is not an edit. */
let applyingExternal = false;

const changePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-vscode-sync"),
      view: () => ({
        update(v, prev) {
          if (applyingExternal || v.state.doc.eq(prev.doc)) return;
          dirty = true;
          scheduleSync();
        },
      }),
    }),
);

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), SYNC_DELAY_MS);
}

/** The full text if the editor changed since the last sync; posts it unless `silent` (or not the writer). */
function sync(silent = false): string | null {
  clearTimeout(syncTimer);
  if (!dirty || !crepe) return null;
  dirty = false;
  let markdown = "";
  crepe.editor.action((ctx) => {
    markdown = serialize(ctx);
  });
  const back = threadsBlock();
  if (markdown === lastSerialized && front === lastFront && back === lastBack) return null;
  lastSerialized = markdown;
  lastFront = front;
  lastBack = back;
  const text = joinDocument(front, gap, unescapeWikiLinks(markdown)) + (back ? `${markdown ? "\n" : ""}${back}` : "");
  if (text === lastText) return null;
  lastText = text;
  if (!silent && writer) post({ type: "edit", text });
  return text;
}

function serialize(ctx: Ctx): string {
  return normalizeTrailingNewlines(ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
}

async function createEditor(text: string) {
  let body: string;
  ({ front, gap, body } = splitDocument(text));
  lastFront = front;
  const { body: markdown, block } = splitThreads(body);
  loadingThreads = true;
  threadStore.load(block);
  loadingThreads = false;
  frontmatterPanel.set(front);
  lastText = text;
  crepe = buildEditor({
    root: host,
    markdown,
    onLink: openLink,
    fileDrop,
    onUpload: uploadFromImageBlock,
    proxyDomURL: proxyImageSrc,
    toolbarHost,
    onCommentActivate: (id) => commentsPanel?.open(id),
  });
  crepe.editor.use(changePlugin);
  await crepe.create();
  commentsPanel = new CommentsPanel(() => view);
  crepe.editor.action((ctx) => {
    view = ctx.get(editorViewCtx);
    // Opening a file is not an edit: the editor's normalised form of it is the baseline.
    lastSerialized = serialize(ctx);
    lastBack = threadsBlock();
  });
  editorCreated();
}

/**
 * Bring the editor in line with text changed outside it (the source editor,
 * VS Code's undo, git). Only the differing range of the document is replaced,
 * so the caret and scroll position survive.
 */
function applyExternal(text: string) {
  // In a session, only the writer follows its file (and shares what changed
  // there); the others' files are written for them.
  if (collab && !writer) return;
  // Unsynced keystrokes go first, so the host's text is compared with the editor's latest.
  sync();
  if (!crepe || text === lastText) return;
  lastText = text;
  let body: string;
  ({ front, gap, body } = splitDocument(text));
  lastFront = front;
  frontmatterPanel.set(front);
  collab?.setFront(front);
  const { body: markdown, block } = splitThreads(body);
  loadThreads(block);
  collab?.setThreads(sharedThreads());
  crepe.editor.action((ctx) => {
    const v = ctx.get(editorViewCtx);
    const next = ctx.get(parserCtx)(markdown);
    if (!next) return;
    const doc = v.state.doc;
    const start = doc.content.findDiffStart(next.content);
    if (start !== null && start !== undefined) {
      let { a: endA, b: endB } = doc.content.findDiffEnd(next.content)!;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      const tr = v.state.tr.replace(start, endA, next.slice(start, endB));
      tr.setMeta("addToHistory", false);
      applyingExternal = true;
      try {
        v.dispatch(tr);
      } finally {
        applyingExternal = false;
      }
    }
    lastSerialized = serialize(ctx);
    lastBack = threadsBlock();
  });
}

// --- Test hooks (driven by the integration tests through the host) ----------------

function runTest(action: TestAction): unknown {
  switch (action.kind) {
    case "getMarkdown":
      sync();
      return lastText;
    case "insertText": {
      if (!view) return false;
      const { state } = view;
      const sel =
        action.at === "start"
          ? TextSelection.atStart(state.doc)
          : action.at === "caret"
            ? state.selection
            : TextSelection.atEnd(state.doc);
      view.dispatch(state.tr.setSelection(sel).insertText(action.text));
      return true;
    }
    case "getStyle": {
      const el = document.querySelector(action.selector);
      return el ? getComputedStyle(el).getPropertyValue(action.property) : null;
    }
    case "count":
      return document.querySelectorAll(action.selector).length;
    case "fill": {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(action.selector);
      if (!el) return false;
      el.focus();
      el.value = action.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    case "click": {
      const el = document.querySelector<HTMLElement>(action.selector);
      el?.click();
      return !!el;
    }
    case "caretAfter": {
      if (!view) return false;
      let found = -1;
      view.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        const i = node.isText ? node.text!.indexOf(action.text) : -1;
        if (i >= 0) found = pos + i + action.text.length;
        return found < 0;
      });
      if (found < 0) return false;
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
      return true;
    }
    case "transfer": {
      if (!view) return false;
      const dt = new DataTransfer();
      for (const f of action.files ?? []) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      if (action.uris) dt.setData("text/uri-list", action.uris.join("\r\n"));
      if (action.event === "paste") {
        view.focus();
        view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      }
      let x: number;
      let y: number;
      if (action.margin) {
        const r = scroll.getBoundingClientRect();
        x = r.left + 8;
        y = r.bottom - 8;
      } else {
        const c = view.coordsAtPos(view.state.selection.from);
        x = c.left;
        y = (c.top + c.bottom) / 2;
      }
      const target = document.elementFromPoint(x, y) ?? view.dom;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      return true;
    }
    case "selectText": {
      if (!view) return false;
      let from = -1;
      view.state.doc.descendants((node, pos) => {
        if (from >= 0) return false;
        const i = node.isText ? node.text!.indexOf(action.text) : -1;
        if (i >= 0) from = pos + i;
        return from < 0;
      });
      if (from < 0) return false;
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + action.text.length)));
      return true;
    }
    case "images":
      return [...document.querySelectorAll<HTMLImageElement>(".ProseMirror img:not(.ProseMirror-separator)")].map(
        (img) => ({ src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0 }),
      );
    case "getAttr":
      return document.querySelector(action.selector)?.getAttribute(action.name) ?? null;
    case "undo": {
      if (!view) return false;
      const shared = sharedHistory(view.state);
      return shared ? shared.undo(view.state, view.dispatch) : undo(view.state, view.dispatch);
    }
    case "collab":
      sync();
      return { active: !!collab, writer, people: collab?.people().map((p) => p.name) ?? [] };
    case "key": {
      if (!view) return false;
      view.focus();
      const init = {
        key: action.key,
        code: action.code,
        metaKey: !!action.meta,
        ctrlKey: !!action.ctrl,
        shiftKey: !!action.shift,
        bubbles: true,
        cancelable: true,
      };
      // What the page itself did with the key, before any round trip to
      // VS Code: whether it was left to VS Code, and whether the editor changed.
      const before = view.state.doc;
      const down = new KeyboardEvent("keydown", init);
      view.dom.dispatchEvent(down);
      view.dom.dispatchEvent(new KeyboardEvent("keyup", init));
      return { leftToVsCode: down.defaultPrevented, editorChanged: view.state.doc !== before };
    }
  }
}

// --- Wiring --------------------------------------------------------------------------

// Keys VS Code owns (see keys.ts), and focus, which scopes those keybindings
// to this editor (`kenMarkdown.editorFocused`).
installKeyRouting();
initShortcutsPanel(post);
onLastHeadingLevel((level) => post({ type: "setPrefs", prefs: { lastHeading: level } }));
window.addEventListener("focus", () => post({ type: "focus", focused: true }));
window.addEventListener("blur", () => post({ type: "focus", focused: false }));

function runCommand(id: string) {
  if (!crepe) return;
  if (isShortcutsPanelOpen()) closeShortcutsPanel();
  crepe.editor.action((ctx) => execute(ctx, command(id)));
}

window.addEventListener("message", async (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case "init":
      docPath = m.docPath;
      setShortcutLabels(m.shortcuts ?? {});
      setLastHeadingLevel(m.prefs?.lastHeading ?? 1);
      threadStore.author = m.config.commentAuthor || "Me";
      applyConfig(m.config);
      if (!crepe) {
        try {
          await createEditor(m.text);
        } catch (err) {
          post({ type: "error", message: String(err) });
        }
      } else {
        applyExternal(m.text);
      }
      document.body.classList.add("ready");
      return;
    case "update":
      applyExternal(m.text);
      return;
    case "config":
      applyConfig(m.config);
      return;
    case "command":
      runCommand(m.id);
      return;
    case "shortcuts":
      setShortcutLabels(m.labels);
      return;
    case "showShortcuts":
      toggleShortcutsPanel();
      return;
    case "flush":
      post({ type: "flushed", id: m.id, text: writer ? sync(true) : null });
      return;
    case "collabStart":
    case "collabUpdate":
    case "collabAwareness":
    case "collabWriter":
    case "collabStop":
      // In order, and only once the editor exists.
      collabChain = collabChain.then(async () => {
        await created;
        try {
          onCollabMessage(m);
        } catch (err) {
          post({ type: "error", message: `collaboration: ${err}` });
        }
      });
      return;
    case "attachmentSaved":
    case "resolved":
    case "linkedUris":
    case "fileRead":
    case "fileWritten":
    case "diagramCreated":
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
      return;
    case "test": {
      post({ type: "testResult", id: m.id, result: runTest(m.action) });
      return;
    }
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});

// Already focused when the page loads (e.g. a reopened editor).
if (document.hasFocus()) post({ type: "focus", focused: true });

// Losing focus (switching tabs, clicking the source view) syncs immediately.
window.addEventListener("blur", () => sync());

window.addEventListener("error", (e) => post({ type: "error", message: String(e.message) }));

post({ type: "ready" });
