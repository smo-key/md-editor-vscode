/**
 * Pasting and dropping files into the document.
 *
 * - Images are saved beside the document and shown; non-image files are saved
 *   beside it and linked. Either way the Markdown gets a relative,
 *   percent-encoded path, so the file stays portable.
 * - Files dragged from VS Code's Explorer (hold Shift while dropping) arrive as
 *   URIs, not file contents: they are linked where they are, nothing is copied.
 * - Placement never breaks a line in two: links go inline where the caret or
 *   drop point is; images replace an empty line or go before/after the
 *   paragraph (inline in table cells, which hold a single line).
 *
 * These are DOM handlers, so they run before Milkdown's upload plugin and
 * Crepe's drop indicator, which would otherwise splice blocks into the middle
 * of a paragraph.
 */
import { Fragment, type Node as ProseNode, type Schema } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** A file ready to be referenced from the document. */
export interface Attachment {
  /** Relative, percent-encoded href (or an absolute URI). */
  href: string;
  /** Text for a link; alt text stays empty for images. */
  name: string;
  image: boolean;
}

export interface FileDropOptions {
  /** Save a pasted or dropped file; undefined when it could not be saved. */
  save(file: File): Promise<Attachment | undefined>;
  /** Attachments for URIs dropped from VS Code (linked, not copied). */
  link(uris: string[]): Promise<Attachment[]>;
}

const IN_CELL = new Set(["table_cell", "table_header"]);

/** The link text node for an attachment. */
function linkText(schema: Schema, a: Attachment): ProseNode {
  return schema.text(a.name, [schema.marks.link.create({ href: a.href })]);
}

function imageNode(schema: Schema, a: Attachment, inline: boolean): ProseNode | null {
  const type = inline ? schema.nodes.image : (schema.nodes["image-block"] ?? schema.nodes.image);
  return type?.createAndFill({ src: a.href }) ?? null;
}

/**
 * Insert attachments at `pos` without leaving debris or splitting the line.
 * Returns the transaction with the caret after what was inserted.
 */
export function insertAttachments(tr: Transaction, pos: number, attachments: Attachment[]): Transaction {
  if (attachments.length === 0) return tr;
  const { schema } = tr.doc.type;
  const $pos = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
  const parent = $pos.parent;
  const inCell = $pos.depth > 0 && IN_CELL.has($pos.node($pos.depth - 1).type.name);
  const canInline = parent.inlineContent && parent.type.allowsMarkType(schema.marks.link);
  const allLinks = attachments.every((a) => !a.image);

  // Inline: links anywhere text goes; everything in a table cell.
  if (canInline && (allLinks || inCell)) {
    const nodes: ProseNode[] = [];
    attachments.forEach((a, i) => {
      if (i > 0) nodes.push(schema.text(" "));
      const node = a.image ? imageNode(schema, a, true) : linkText(schema, a);
      if (node) nodes.push(node);
    });
    const before = $pos.parentOffset > 0 ? parent.textBetween($pos.parentOffset - 1, $pos.parentOffset, "", "\ufffc") : "";
    const after = $pos.parentOffset < parent.content.size ? parent.textBetween($pos.parentOffset, $pos.parentOffset + 1, "", "\ufffc") : "";
    if (before && !/\s/.test(before)) nodes.unshift(schema.text(" "));
    if (after && !/\s/.test(after)) nodes.push(schema.text(" "));
    tr.insert($pos.pos, Fragment.from(nodes));
    const end = $pos.pos + nodes.reduce((n, node) => n + node.nodeSize, 0);
    return tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView();
  }

  // Blocks: images as image blocks, links as paragraphs of their own.
  const blocks: ProseNode[] = [];
  for (const a of attachments) {
    const node = a.image ? imageNode(schema, a, false) : schema.nodes.paragraph.create(null, linkText(schema, a));
    if (node) blocks.push(node);
  }
  const content = Fragment.from(blocks);
  let at: number;
  if (parent.isTextblock && $pos.depth > 0) {
    if (parent.content.size === 0) {
      tr.replaceWith($pos.before(), $pos.after(), content);
      at = $pos.before();
    } else {
      at = $pos.parentOffset === 0 ? $pos.before() : $pos.after();
      tr.insert(at, content);
    }
  } else {
    at = $pos.pos;
    tr.insert(at, content);
  }
  const end = at + content.size;
  const sel = TextSelection.findFrom(tr.doc.resolve(end), 1, true) ?? TextSelection.near(tr.doc.resolve(end), -1);
  return tr.setSelection(sel).scrollIntoView();
}

/** Drag data types VS Code's Explorer (and other sources of file URIs) use. */
const URI_TYPES = ["application/vnd.code.uri-list", "text/uri-list", "resourceurls", "codefiles"];

function parseList(type: string, raw: string): string[] {
  if (type === "resourceurls" || type === "codefiles") {
    try {
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) return [];
      return list
        .filter((v): v is string => typeof v === "string")
        .map((v) => (type === "codefiles" && v.startsWith("/") ? `file://${encodeURI(v)}` : v));
    } catch {
      return [];
    }
  }
  return raw.split(/\r?\n/);
}

/** File URIs in a drop from VS Code's Explorer (or anything giving a uri-list). */
export function droppedUris(data: DataTransfer | null): string[] {
  if (!data) return [];
  const types = data.types.map((t) => t.toLowerCase());
  for (const type of URI_TYPES) {
    if (!types.includes(type)) continue;
    const uris = parseList(type, data.getData(type))
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && /^(file|vscode-[\w-]+):/i.test(l));
    if (uris.length) return uris;
  }
  return [];
}

function hasFiles(data: DataTransfer | null): boolean {
  return !!data && data.files.length > 0;
}

/** Nearest document position to a point, clamped into the text column. */
export function nearestPos(view: EditorView, x: number, y: number): number {
  const rect = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  const top = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
  return view.posAtCoords({ left, top })?.pos ?? view.state.doc.content.size;
}

/** Insert points waiting for their files to save, kept in step with edits. */
const pending = new Set<{ pos: number }>();

/** Save (or link) the files, then insert them at `pos` as it is by then. */
async function importAndInsert(view: EditorView, pos: number, work: Promise<(Attachment | undefined)[]>) {
  const marker = { pos };
  pending.add(marker);
  try {
    const attachments = (await work).filter((a): a is Attachment => !!a);
    if (attachments.length === 0) return;
    view.dispatch(insertAttachments(view.state.tr, marker.pos, attachments));
    view.focus();
  } finally {
    pending.delete(marker);
  }
}

const saveAll = (options: FileDropOptions, files: File[]) =>
  Promise.all(files.map((f) => options.save(f).catch(() => undefined)));

/** Whether a drag carries something a drop would insert. */
export function carriesFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = data.types.map((t) => t.toLowerCase());
  return types.includes("files") || URI_TYPES.some((t) => types.includes(t));
}

/**
 * Handle a drop of files or Explorer URIs anywhere over the editor (the
 * margins included: the nearest document position is used). False when the
 * drop carries neither, so other handlers can have it.
 */
export function handleFileDrop(view: EditorView, event: DragEvent, options: FileDropOptions): boolean {
  const data = event.dataTransfer;
  const uris = hasFiles(data) ? [] : droppedUris(data);
  if (!hasFiles(data) && uris.length === 0) return false;
  event.preventDefault();
  const pos = nearestPos(view, event.clientX, event.clientY);
  const work = uris.length ? options.link(uris) : saveAll(options, Array.from(data!.files));
  void importAndInsert(view, pos, work);
  return true;
}

export function fileDropPlugin(options: FileDropOptions) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey("ken-file-drop"),
        state: {
          init: () => null,
          apply(tr) {
            if (tr.docChanged) for (const m of pending) m.pos = tr.mapping.map(m.pos);
            return null;
          },
        },
        props: {
          handleDOMEvents: {
            paste: (view, event) => {
              const data = event.clipboardData;
              // An image copied from a web page arrives as HTML too; that pastes
              // as a link to the original rather than a saved copy.
              if (!hasFiles(data) || data!.getData("text/html")) return false;
              event.preventDefault();
              void importAndInsert(view, view.state.selection.from, saveAll(options, Array.from(data!.files)));
              return true;
            },
            drop: (view, event) => handleFileDrop(view, event, options),
            dragover: (_view, event) => {
              const data = event.dataTransfer;
              if (!data || !carriesFiles(data)) return false;
              // Accept the drop (the default would refuse files).
              event.preventDefault();
              data.dropEffect = "copy";
              return false;
            },
          },
        },
      }),
  );
}
