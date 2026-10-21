// Path policy for files pasted or dropped into a Markdown document: they are
// saved beside the document and linked with a path relative to it, and a
// relative image src in the document is resolved back to a project path for
// display. Pure so vitest covers the policy; the editor and the backend
// command (`write_new_file`, which sanitizes and dedupes) are thin shells.

/**
 * How the editor reaches storage. In the app: `write_new_file` + `media_src`;
 * the harness swaps in an in-memory fake. Without one the editor keeps Crepe's
 * stock behaviour.
 */
export interface AttachmentAdapter {
  /** Save `file` beside the document; resolves to its project-relative path. */
  save(file: File): Promise<string>;
  /** A URL the webview can load for a project-relative path. */
  resolve(relPath: string): Promise<string> | string;
}

/** The bits of a `File` the policy looks at, so tests need no real File. */
export interface FileLike {
  name: string;
  type: string;
}

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff",
]);

const MIME_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/zip": "zip",
  "application/json": "json",
};

/** Folder holding the document ("" for a document at the project root). */
export function docDir(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
}

/** File extension for a MIME type, `bin` when unknown. */
export function extFromMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_EXTS[base] ?? "bin";
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a path names an image, by extension. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path));
}

/** Whether a file is an image: its MIME type when it has one, else its name. */
export function isImageFile(file: FileLike): boolean {
  if (file.type) return file.type.toLowerCase().startsWith("image/");
  return isImagePath(file.name);
}

/** WebKit hands clipboard images over as `image.png` (or nameless). */
function isGenericPastedName(name: string): boolean {
  return name === "" || /^image\.[a-z0-9]+$/i.test(name);
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The name to save an attachment under. A real file keeps its own name; a
 * clipboard image gets `<doc-stem>-pasted-YYYYMMDD-HHMMSS.<ext>` so a folder of
 * screenshots stays legible. Collisions are the backend's job.
 */
export function attachmentName(
  file: FileLike,
  docRelPath: string | undefined,
  now: Date,
): string {
  if (!isGenericPastedName(file.name)) return file.name;
  const ext = file.type ? extFromMime(file.type) : extOf(file.name) || "bin";
  const leaf = docRelPath?.slice(docRelPath.lastIndexOf("/") + 1) ?? "";
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stem ? `${stem}-` : ""}pasted-${stamp}.${ext}`;
}

/** Path from folder `fromDir` to project path `target`, `../` where needed. */
export function relativeTo(fromDir: string, target: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const to = target.split("/");
  let common = 0;
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common] === to[common]
  ) {
    common++;
  }
  const up = from.slice(common).map(() => "..");
  return [...up, ...to.slice(common)].join("/");
}

/**
 * A relative path made safe for a CommonMark link destination: each segment is
 * percent-encoded, parentheses included — `encodeURIComponent` leaves those,
 * and an unbalanced one would end the link early.
 */
export function encodeHref(relPath: string): string {
  return relPath
    .split("/")
    .map((seg) =>
      seg === "." || seg === ".."
        ? seg
        : encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29"),
    )
    .join("/");
}

/**
 * The project path a document-relative src points at, or null when the src is
 * not a relative file path (a URL with a scheme, a fragment, a root-absolute
 * path) or climbs out of the project.
 */
export function resolveSrc(docRelPath: string, src: string): string | null {
  if (!src || src.startsWith("#") || src.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  const path = src.split(/[?#]/)[0];
  const parts = docDir(docRelPath).split("/").filter(Boolean);
  for (const raw of path.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? parts.join("/") : null;
}
