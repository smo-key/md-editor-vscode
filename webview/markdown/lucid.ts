/**
 * Lucidchart previews (docs/specs/lucidchart-embeds.md §6.3).
 *
 * A Lucid document link alone in its paragraph gets a live preview under it:
 * Lucid's embedded viewer in a sandboxed frame, with Edit, Open and Reload.
 * A linked published image (`[![…](…/publicSegments/view/<id>/image.png)](…)`)
 * already shows as an image and gets the same buttons. The link stays an
 * ordinary link in the file: the preview is a widget decoration, so this
 * plugin never changes the document (safe for collaboration and remote
 * transactions; nothing to skip in remoteChange.ts).
 *
 * Widgets carry a key that doesn't depend on position, so ProseMirror keeps
 * their DOM (and the loaded frame) while the user types elsewhere.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { ExternalLink, Image, Pencil, RotateCw, Workflow, createElement, type IconNode } from "lucide";

import {
  embedUrl,
  lucidPreviewMode,
  parseLucidUrl,
  type LucidDocumentRef,
  type LucidImageRef,
  type LucidPreviewMode,
} from "../../src/lucidUrl";

export type LucidMode = LucidPreviewMode;

export interface LucidOptions {
  /** The `kenMarkdown.lucidchart.preview` setting, read at each rebuild. */
  mode: () => LucidMode;
  /** Edit or Open was clicked: the host re-validates `url` and opens the browser. */
  open: (url: string, action: "edit" | "open") => void;
  /** A link in the card's own text (the help article) was clicked. */
  openLink?: (href: string) => void;
}

type DocRef = LucidDocumentRef;
type ImageRef = LucidImageRef;

export interface LucidBlock {
  /** Start of the source paragraph (or image block). */
  pos: number;
  /** Its end: where the widget goes. */
  end: number;
  /** `frame`: a document link, previewed in a frame. `image`: a published image. */
  form: "frame" | "image";
  /** The linked document; absent for a bare published image. */
  doc?: DocRef;
  image?: ImageRef;
  title: string;
  /** Position-independent widget key: `lucid:<form>:<id>:<n>`. */
  key: string;
}

/** Meta on a transaction that rebuilds the previews (after a config change). */
export const lucidRefreshKey = new PluginKey("ken-lucid-refresh");

export const LUCID_TITLE = "Lucidchart diagram";
export const LUCID_HELP_URL = "https://help.lucid.co/hc/en-us/articles/16181914460692";
const TIMEOUT_MS = 20_000;
const CONTAINERS = new Set(["doc", "bullet_list", "ordered_list", "list_item", "blockquote", "github_alert"]);

/** What a paragraph holds when it is only one link, or only one image (maybe linked). */
function soleContent(p: ProseNode): { href: string; text: string; image?: ProseNode } | { image: ProseNode; href?: undefined } | null {
  let href: string | null = null;
  let text = "";
  let image: ProseNode | null = null;
  let ended = false;
  let ok = true;
  p.forEach((child) => {
    if (!ok) return;
    const link = child.marks.find((m) => m.type.name === "link");
    if (!link) {
      if ((child.isText && !child.text?.trim()) || child.type.name === "hardbreak") {
        if (href !== null || image) ended = true;
        return;
      }
      if (child.type.name === "image" && !image && href === null && !ended) {
        image = child;
        ended = true;
        return;
      }
      ok = false;
      return;
    }
    const h = String(link.attrs.href ?? "");
    if (ended || (href !== null && h !== href)) {
      ok = false;
      return;
    }
    href = h;
    if (child.type.name === "image") {
      if (image) ok = false;
      image = child;
    } else if (child.isText) text += child.text ?? "";
    else ok = false;
  });
  if (!ok) return null;
  const img = image as ProseNode | null;
  if (href !== null) return img && text.trim() ? null : { href, text, ...(img ? { image: img } : {}) };
  return img ? { image: img } : null;
}

// `href` is kept exactly as the document has it: that is what the actions
// post (the host parses it again).
function asImage(src: unknown): ImageRef | null {
  const href = String(src ?? "");
  const ref = parseLucidUrl(href);
  return ref?.kind === "image" ? { ...ref, href } : null;
}

function asDoc(href: string): DocRef | null {
  const ref = parseLucidUrl(href);
  return ref?.kind === "document" ? { ...ref, href } : null;
}

/** The link text as a title, unless it is just the URL. */
function titleOf(text: string, href: string): string {
  const t = text.trim();
  return !t || t === href || /^(https?:\/\/|www\.)/i.test(t) ? LUCID_TITLE : t;
}

type Found = Omit<LucidBlock, "key">;

function candidate(node: ProseNode, pos: number): Found | null {
  const end = pos + node.nodeSize;
  if (node.type.name === "image-block") {
    const image = asImage(node.attrs.src);
    return image ? { pos, end, form: "image", image, title: String(node.attrs.caption || node.attrs.alt || "") || LUCID_TITLE } : null;
  }
  if (node.type.name !== "paragraph") return null;
  const sole = soleContent(node);
  if (!sole) return null;
  if (sole.image) {
    const image = asImage(sole.image.attrs.src);
    if (!image) return null;
    const title = String(sole.image.attrs.alt ?? "") || LUCID_TITLE;
    if (sole.href === undefined) return { pos, end, form: "image", image, title };
    const doc = asDoc(sole.href);
    return doc ? { pos, end, form: "image", image, doc, title } : null;
  }
  const doc = asDoc(sole.href!);
  return doc ? { pos, end, form: "frame", doc, title: titleOf((sole as { text: string }).text, sole.href!) } : null;
}

/** Every previewable block: paragraphs (and image blocks) directly in the
 *  document, a list item, a quote or an alert; never in a table. */
export function findLucidBlocks(doc: ProseNode): LucidBlock[] {
  const found: Found[] = [];
  const walk = (parent: ProseNode, start: number) => {
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (CONTAINERS.has(child.type.name)) walk(child, pos + 1);
      else {
        const c = candidate(child, pos);
        if (c) found.push(c);
      }
    });
  };
  walk(doc, 0);
  const seen = new Map<string, number>();
  return found.map((b) => {
    const base = `lucid:${b.form}:${b.form === "frame" ? b.doc!.id : b.image!.publicId}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...b, key: `${base}:${n}` };
  });
}

// --- Card DOM ------------------------------------------------------------------

function icon(node: IconNode): SVGElement {
  return createElement(node, { width: 13, height: 13, "stroke-width": 1.75, "aria-hidden": "true" });
}

function button(label: string, onClick: () => void, opts: { icon?: IconNode; title?: string; className?: string } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ken-lucid-button${opts.className ? ` ${opts.className}` : ""}`;
  if (opts.icon) b.append(icon(opts.icon));
  b.append(document.createTextNode(label));
  if (opts.title) b.title = opts.title;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

type State = "idle" | "click" | "offline" | "loading" | "loaded" | "timeout";

interface Card {
  dom: HTMLElement;
  update(block: LucidBlock, mode: LucidMode): void;
  setSelected(on: boolean): void;
  /** The window got focus back: reload if Edit or Open was used. */
  returned(): void;
  destroy(): void;
}

/** The preview card for a document link. */
function frameCard(initial: LucidBlock, initialMode: LucidMode, options: LucidOptions | undefined): Card {
  let block = initial;
  let mode = initialMode;
  let state: State = "idle";
  let visible = false;
  let requested = mode === "auto";
  let started = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingOnline = false;
  let clicked = false;

  const dom = document.createElement("div");
  dom.className = "ken-lucid-card";
  dom.contentEditable = "false";
  dom.setAttribute("role", "group");

  const header = document.createElement("div");
  header.className = "ken-lucid-header";
  const badge = document.createElement("span");
  badge.className = "ken-lucid-icon";
  badge.append(icon(Workflow));
  const title = document.createElement("span");
  title.className = "ken-lucid-title";
  const actions = document.createElement("span");
  actions.className = "ken-lucid-actions";
  const act = (action: "edit" | "open") => () => {
    pending = true;
    options?.open(block.doc!.href, action);
  };
  actions.append(
    button("Edit", act("edit"), { icon: Pencil, title: "Edit in your browser", className: "ken-lucid-edit" }),
    button("Open in Lucidchart", act("open"), { icon: ExternalLink, className: "ken-lucid-open" }),
    button("Reload", () => reload(), { icon: RotateCw, title: "Reload the preview", className: "ken-lucid-reload" }),
  );
  header.append(badge, title, actions);

  const body = document.createElement("div");
  body.className = "ken-lucid-body";
  const frame = document.createElement("iframe");
  frame.className = "ken-lucid-frame";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute("referrerpolicy", "strict-origin");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("allow", "");
  const fallback = document.createElement("div");
  fallback.className = "ken-lucid-state";
  body.append(frame, fallback);

  const hint = document.createElement("div");
  hint.className = "ken-lucid-hint";
  const help = document.createElement("a");
  help.href = LUCID_HELP_URL;
  help.textContent = "publish it as an image";
  help.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    options?.openLink?.(LUCID_HELP_URL);
  });
  hint.append(
    document.createTextNode("Blank, or asking you to sign in? The owner can turn on More › Embed › Activate Embed Code in Lucid, or "),
    help,
    document.createTextNode(" and link that here."),
  );
  dom.append(header, body, hint);

  const text = (s: string, cls = "ken-lucid-message") => {
    const p = document.createElement("div");
    p.className = cls;
    p.textContent = s;
    return p;
  };
  const setState = (s: State) => {
    state = s;
    dom.dataset.state = s;
    if (s === "click") {
      const row = document.createElement("div");
      row.className = "ken-lucid-state-actions";
      row.append(
        button("Load preview", () => {
          clicked = true;
          requested = true;
          visible = true;
          load();
        }),
      );
      fallback.replaceChildren(text("Lucidchart preview", "ken-lucid-state-title"), row, text("Loads from lucid.app.", "ken-lucid-small"));
    } else if (s === "offline") {
      fallback.replaceChildren(text("You're offline. The preview loads when you're back online."));
    } else if (s === "timeout") {
      const row = document.createElement("div");
      row.className = "ken-lucid-state-actions";
      row.append(button("Try again", () => reload()), button("Open in Lucidchart", act("open")));
      fallback.replaceChildren(text("Lucidchart could not be reached."), row);
    } else fallback.replaceChildren();
  };

  const onOnline = () => {
    waitingOnline = false;
    window.removeEventListener("online", onOnline);
    load();
  };
  function load() {
    if (navigator.onLine === false) {
      setState("offline");
      if (!waitingOnline) {
        waitingOnline = true;
        window.addEventListener("online", onOnline);
      }
      return;
    }
    started = true;
    clearTimeout(timer);
    setState("loading");
    frame.src = embedUrl(block.doc!);
    timer = setTimeout(() => {
      if (state === "loading") setState("timeout");
    }, TIMEOUT_MS);
  }
  function reload() {
    requested = true;
    visible = true;
    load();
  }
  frame.addEventListener("load", () => {
    if (!frame.getAttribute("src")) return;
    clearTimeout(timer);
    setState("loaded");
  });

  const maybeStart = () => {
    if (started || waitingOnline) return;
    if (!requested) {
      if (state !== "click") setState("click");
      return;
    }
    if (visible) load();
  };

  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            io?.disconnect();
            visible = true;
            maybeStart();
          },
          { rootMargin: "400px 0px" },
        )
      : null;

  const card: Card = {
    dom,
    update(next, nextMode) {
      const oldUrl = block.doc ? embedUrl(block.doc) : "";
      block = next;
      const t = next.title;
      title.textContent = t;
      dom.setAttribute("aria-label", `${LUCID_TITLE}: ${t}`);
      frame.title = `${t} (Lucidchart)`;
      const url = embedUrl(next.doc!);
      frame.dataset.src = url;
      if (nextMode !== mode) {
        mode = nextMode;
        if (mode === "auto") requested = true;
        else if (!started && !clicked) requested = false;
      }
      if (started && url !== oldUrl) load();
      else maybeStart();
    },
    setSelected(on) {
      dom.classList.toggle("ken-lucid-selected", on);
    },
    returned() {
      if (!pending) return;
      pending = false;
      if (started) load();
    },
    destroy() {
      clearTimeout(timer);
      io?.disconnect();
      window.removeEventListener("online", onOnline);
    },
  };
  setState("idle");
  card.update(block, mode);
  if (io) io.observe(dom);
  else {
    visible = true;
    maybeStart();
  }
  return card;
}

/** The toolbar under a published image (its paragraph shows the image itself). */
function imageToolbar(initial: LucidBlock, view: () => EditorView | null, options: LucidOptions | undefined): Card {
  let block = initial;
  let pending = false;
  const dom = document.createElement("div");
  dom.className = "ken-lucid-toolbar";
  dom.contentEditable = "false";
  dom.setAttribute("role", "group");

  const reload = () => {
    const v = view();
    const node = v?.nodeDOM(block.pos);
    if (!(node instanceof HTMLElement)) return;
    const img = node instanceof HTMLImageElement ? node : node.querySelector<HTMLImageElement>("img:not(.ProseMirror-separator)");
    const src = img?.getAttribute("src");
    if (!img || !src) return;
    const base = src.replace(/[?&]v=\d+$/, "");
    img.setAttribute("src", `${base}${base.includes("?") ? "&" : "?"}v=${Date.now()}`);
  };
  const act = (href: string, action: "edit" | "open") => () => {
    pending = true;
    options?.open(href, action);
  };
  const render = () => {
    const d = block.doc;
    dom.setAttribute("aria-label", `${LUCID_TITLE}: ${block.title}`);
    dom.replaceChildren(
      ...(d
        ? [
            button("Edit", act(d.href, "edit"), { icon: Pencil, title: "Edit in your browser", className: "ken-lucid-edit" }),
            button("Open in Lucidchart", act(d.href, "open"), { icon: ExternalLink, className: "ken-lucid-open" }),
            button("Reload", reload, { icon: RotateCw, title: "Reload the image", className: "ken-lucid-reload" }),
          ]
        : [button("Open image", act(block.image!.href, "open"), { icon: Image, className: "ken-lucid-open" })]),
    );
  };
  let shown = "";
  return {
    dom,
    update(next) {
      block = next;
      const sig = `${next.doc?.href ?? ""}\n${next.image?.href ?? ""}\n${next.title}`;
      if (sig !== shown) {
        shown = sig;
        render();
      }
    },
    setSelected(on) {
      dom.classList.toggle("ken-lucid-selected", on);
    },
    returned() {
      if (!pending) return;
      pending = false;
      reload();
    },
    destroy() {},
  };
}

// --- Plugin --------------------------------------------------------------------

interface PluginState {
  blocks: LucidBlock[];
  mode: LucidMode;
  decorations: DecorationSet;
}

const key = new PluginKey<PluginState>("ken-lucid");

export function lucidPlugin(options?: LucidOptions) {
  const modeOf = (): LucidMode => {
    return lucidPreviewMode(options?.mode());
  };
  return $prose(() => {
    const cards = new Map<string, Card>();
    let currentView: EditorView | null = null;

    const cardFor = (block: LucidBlock, mode: LucidMode): Card => {
      let card = cards.get(block.key);
      if (!card) {
        card = block.form === "frame" ? frameCard(block, mode, options) : imageToolbar(block, () => currentView, options);
        card.update(block, mode);
        cards.set(block.key, card);
      }
      return card;
    };

    const build = (doc: ProseNode): PluginState => {
      const mode = modeOf();
      const blocks = mode === "off" ? [] : findLucidBlocks(doc);
      const decos: Decoration[] = [];
      for (const b of blocks) {
        decos.push(Decoration.node(b.pos, b.end, { class: "ken-lucid-source" }));
        decos.push(
          Decoration.widget(b.end, () => cardFor(b, mode).dom, {
            key: b.key,
            side: 1,
            ignoreSelection: true,
            stopEvent: () => true,
          }),
        );
      }
      return { blocks, mode, decorations: DecorationSet.create(doc, decos) };
    };

    const sync = (state: EditorState) => {
      const s = key.getState(state);
      if (!s) return;
      const live = new Set<string>();
      const { from, to } = state.selection;
      for (const b of s.blocks) {
        live.add(b.key);
        const card = cardFor(b, s.mode);
        card.update(b, s.mode);
        card.setSelected(from < to && from <= b.pos + 1 && to >= b.end - 1);
      }
      for (const [k, card] of cards) {
        if (live.has(k)) continue;
        card.destroy();
        cards.delete(k);
      }
    };

    return new Plugin<PluginState>({
      key,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (tr, prev) => (tr.docChanged || tr.getMeta(lucidRefreshKey) ? build(tr.doc) : prev),
      },
      props: {
        decorations: (state) => key.getState(state)?.decorations,
      },
      view: (view) => {
        currentView = view;
        const returned = () => {
          if (document.visibilityState === "hidden") return;
          for (const card of cards.values()) card.returned();
        };
        window.addEventListener("focus", returned);
        document.addEventListener("visibilitychange", returned);
        sync(view.state);
        return {
          update: (v) => sync(v.state),
          destroy: () => {
            window.removeEventListener("focus", returned);
            document.removeEventListener("visibilitychange", returned);
            for (const card of cards.values()) card.destroy();
            cards.clear();
            currentView = null;
          },
        };
      },
    });
  });
}
