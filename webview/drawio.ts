/**
 * draw.io (diagrams.net) diagrams in documents.
 *
 * A diagram is an editable image file: `.drawio.svg` (or `.drawio.png`),
 * draw.io's format for Markdown — an ordinary image that GitHub and every
 * renderer show, with the diagram source embedded in it. The document links
 * it like any image (`![](_Images/notes-diagram.drawio.svg)`), so it displays
 * like one here too.
 *
 * Editing opens the diagrams.net editor (its official embed mode, in a frame
 * over the document); saving writes the same file back, image and source
 * together. New diagrams are created in the image folder. Without a
 * connection to diagrams.net the file can be opened in VS Code instead (where
 * the Draw.io Integration extension, if installed, edits it).
 */
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { Pencil, createElement } from "lucide";
import { DRAWIO_ORIGIN, isFrameMessage } from "./hostMessage";

export interface DrawioHost {
  /** Root-relative path for an image src in the document, or null. */
  pathOf(src: string): string | null;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Create a blank diagram file; its root-relative path. */
  createDiagram(): Promise<string>;
  /** The href to use in the document for a root-relative path. */
  hrefFor(path: string): string;
  openInVsCode(path: string): void;
}

let host: DrawioHost | null = null;
export function initDrawio(h: DrawioHost): void {
  host = h;
}

export const isDrawioSrc = (src: string | null | undefined): boolean =>
  !!src && /\.drawio\.(svg|png)$/i.test(decodeURIComponent(src.split(/[?#]/)[0] ?? ""));

/** The diagram source (mxfile XML) inside a .drawio.svg, or null. */
export function diagramXml(svgText: string): string | null {
  const m = /\scontent="([^"]*)"/.exec(svgText);
  if (!m) return null;
  const doc = new DOMParser().parseFromString(`<x a="${m[1]}"/>`, "text/xml");
  return doc.documentElement.getAttribute("a");
}

/** Bump per saved file, so images reload instead of showing the cached version. */
const versions = new Map<string, number>();
export function versionOf(path: string): number | undefined {
  return versions.get(path);
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromDataUri = (uri: string) => {
  const b64 = uri.slice(uri.indexOf(",") + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const EDITOR = `${DRAWIO_ORIGIN}/`;

let open: { close: () => void } | null = null;

/** Edit the diagram at `src` (as written in the document). */
export async function editDiagram(src: string, onSaved?: () => void): Promise<void> {
  if (!host || open) return;
  const path = host.pathOf(src);
  if (!path) return;
  const h = host;
  const png = /\.png$/i.test(path);
  let load: Record<string, string>;
  try {
    const bytes = await h.readFile(path);
    load = png
      ? { xmlpng: `data:image/png;base64,${toBase64(bytes)}` }
      : { xml: diagramXml(new TextDecoder().decode(bytes)) ?? "" };
  } catch (err) {
    // Never open a blank editor over an existing file: saving it would erase the diagram.
    if (!open) showNotice(`The diagram could not be read: ${err instanceof Error ? err.message : String(err)}`, h, path);
    return;
  }
  if (open) return;

  const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
  const overlay = document.createElement("div");
  overlay.className = "ken-drawio";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Edit diagram");
  const frame = document.createElement("iframe");
  frame.className = "ken-drawio-frame";
  frame.title = "draw.io";
  const params = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1",
    saveAndExit: "1",
    noExitBtn: "0",
    libraries: "1",
    ui: dark ? "dark" : "kennedy",
    dark: dark ? "1" : "0",
  });
  frame.src = `${EDITOR}?${params}`;
  const status = document.createElement("div");
  status.className = "ken-drawio-status";
  status.textContent = "Opening draw.io…";
  overlay.append(status, frame);
  document.body.append(overlay);

  let exitAfterSave = false;
  let ready = false;
  const post = (msg: object) => frame.contentWindow?.postMessage(JSON.stringify(msg), "*");
  const close = () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("keydown", onKey, true);
    clearTimeout(timer);
    overlay.remove();
    open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !ready) close();
  };
  const onMessage = async (e: MessageEvent) => {
    if (!isFrameMessage(e, frame.contentWindow, DRAWIO_ORIGIN) || typeof e.data !== "string") return;
    let msg: { event?: string; xml?: string; exit?: boolean; data?: string; modified?: boolean };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.event) {
      case "init":
        ready = true;
        overlay.dataset.ready = "true";
        status.remove();
        post({ action: "load", autosave: 0, title: path.slice(path.lastIndexOf("/") + 1), ...load });
        break;
      case "save":
        exitAfterSave = msg.exit === true;
        post({ action: "export", format: png ? "xmlpng" : "xmlsvg", xml: msg.xml, spinKey: "saving" });
        break;
      case "export":
        if (!msg.data) break;
        try {
          await h.writeFile(path, fromDataUri(msg.data));
          versions.set(path, Date.now());
          refreshImages(path);
          onSaved?.();
          if (exitAfterSave) close();
          else post({ action: "status", message: "Saved", modified: false });
        } catch (err) {
          post({ action: "dialog", title: "Could not save", message: String(err), button: "OK", modified: true });
        }
        break;
      case "exit":
        close();
        break;
    }
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onKey, true);
  // No editor (offline, or blocked): offer VS Code instead.
  const timer = setTimeout(() => {
    if (ready) return;
    status.replaceChildren(
      document.createTextNode("draw.io (diagrams.net) could not be reached."),
      button("Open in VS Code", () => {
        close();
        h.openInVsCode(path);
      }),
      button("Close", close),
    );
  }, 15000);
  open = { close };
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** A message over the document in place of the editor, offering VS Code instead. */
function showNotice(message: string, h: DrawioHost, path: string): void {
  const overlay = document.createElement("div");
  overlay.className = "ken-drawio";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-label", "Edit diagram");
  const status = document.createElement("div");
  status.className = "ken-drawio-status";
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  status.append(
    document.createTextNode(message),
    button("Open in VS Code", () => {
      close();
      h.openInVsCode(path);
    }),
    button("Close", close),
  );
  overlay.append(status);
  document.body.append(overlay);
  window.addEventListener("keydown", onKey, true);
  open = { close };
}

/** Reload every displayed copy of a saved diagram. */
function refreshImages(path: string): void {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  for (const img of document.querySelectorAll<HTMLImageElement>(".ProseMirror img")) {
    const src = img.getAttribute("src") ?? "";
    if (!decodeURIComponent(src.split("?")[0] ?? "").endsWith(leaf)) continue;
    img.src = `${src.split("?")[0]}?v=${versions.get(path)}`;
  }
}

/** Insert a new, empty diagram at the caret and start editing it. */
export async function insertDiagram(view: EditorView, insert: (href: string) => void): Promise<void> {
  if (!host) return;
  const path = await host.createDiagram();
  const href = host.hrefFor(path);
  insert(href);
  view.focus();
  await editDiagram(href);
}

/** "Edit diagram" on every diagram image (and a double-click on it). */
export const drawioPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-drawio"),
      props: {
        handleDOMEvents: {
          dblclick: (_view, event) => {
            const img = (event.target as Element | null)?.closest?.("img");
            const src = img?.getAttribute("data-src") ?? img?.closest(".milkdown-image-block")?.getAttribute("data-src");
            if (!img) return false;
            const found = src ?? sourceOf(img);
            if (!isDrawioSrc(found)) return false;
            event.preventDefault();
            void editDiagram(found!);
            return true;
          },
        },
      },
      view: (view) => {
        const sync = () => {
          view.state.doc.descendants((node, pos) => {
            if (node.type.name !== "image-block") return true;
            const dom = view.nodeDOM(pos);
            if (!(dom instanceof HTMLElement)) return false;
            const src = node.attrs.src as string;
            if (dom.getAttribute("data-src") !== src) dom.setAttribute("data-src", src);
            let b = dom.querySelector<HTMLButtonElement>(":scope > .ken-drawio-edit");
            if (!isDrawioSrc(src)) {
              b?.remove();
              return false;
            }
            if (!b) {
              b = document.createElement("button");
              b.type = "button";
              b.className = "ken-drawio-edit";
              b.contentEditable = "false";
              b.append(createElement(Pencil, { width: 13, height: 13, "stroke-width": 1.75 }), document.createTextNode("Edit diagram"));
              b.addEventListener("mousedown", (e) => e.preventDefault());
              b.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                void editDiagram(dom.getAttribute("data-src") ?? src);
              });
              dom.append(b);
            }
            return false;
          });
        };
        const raf = requestAnimationFrame(sync);
        return { update: sync, destroy: () => cancelAnimationFrame(raf) };
      },
    }),
);

/** The document src behind a rendered image (its block's `data-src`). */
function sourceOf(img: HTMLImageElement): string | null {
  return img.closest("[data-src]")?.getAttribute("data-src") ?? null;
}
