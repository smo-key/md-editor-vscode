// Lucid (Lucidchart, Lucidspark) link recognition. Pure: no `vscode` or DOM
// imports, so the extension host and the webview bundle share it, and vitest
// covers it. The webview previews only what this accepts; the host re-parses
// every URL the webview asks it to open (docs/specs/lucidchart-embeds.md §6.2).

/** `unknown` is a `/documents/…` link, which doesn't say; it previews like Lucidchart. */
export type LucidProduct = "lucidchart" | "lucidspark" | "unknown";

export interface LucidDocumentRef {
  kind: "document";
  /** Lower-case RFC 4122 UUID. */
  id: string;
  product: LucidProduct;
  /** Share-link access, kept on the embed and edit URLs. */
  invitationId?: string;
  /** The link as parsed (`URL.href`: trimmed, default port dropped). */
  href: string;
}

export interface LucidImageRef {
  kind: "image";
  /** Lower-case id of the published image. */
  publicId: string;
  href: string;
}

export type LucidRef = LucidDocumentRef | LucidImageRef;

/** When a Lucid link alone in its paragraph loads its preview. */
export type LucidPreviewMode = "auto" | "onClick" | "off";

/** Hosts accepted as Lucid. Previews always load from `lucid.app`. */
export const LUCID_HOSTS: readonly string[] = ["lucid.app", "www.lucidchart.com", "lucidchart.com", "app.lucidchart.com"];

/** The one host frames load from (the CSP `frame-src`). */
export const LUCID_ORIGIN = "https://lucid.app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCTS = new Set(["lucidchart", "lucidspark"]);
const PRODUCT_ACTIONS = new Set(["edit", "view", "comment"]);
const DOCUMENT_VERBS = new Set(["edit", "view", "comment", "embedded", "embeddedchart"]);
/** `/documents/<verb>` links that are a page a person opens (not the embed viewer). */
const OPENABLE_VERBS = new Set(["edit", "view", "comment"]);

export function isLucidHost(hostname: string): boolean {
  return LUCID_HOSTS.includes(hostname.toLowerCase());
}

/** The `lucidchart.preview` setting; anything unknown falls back to `auto`. */
export function lucidPreviewMode(value: unknown): LucidPreviewMode {
  return value === "onClick" || value === "off" ? value : "auto";
}

/** An allowlisted https Lucid URL, or null. */
function lucidUrl(href: unknown): URL | null {
  if (typeof href !== "string") return null;
  let u: URL;
  try {
    u = new URL(href.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  // `URL` drops the default port, so any port left is a non-default one.
  if (u.port) return null;
  return isLucidHost(u.hostname) ? u : null;
}

/** Path segments, without the leading empty one and a trailing slash. */
function segments(u: URL): string[] {
  const s = u.pathname.split("/").slice(1);
  if (s.length && s[s.length - 1] === "") s.pop();
  return s;
}

/**
 * Parse a Lucid document or published-image link. Returns null for anything
 * else, including other Lucid pages (invitations, folders, Lucidscale).
 */
export function parseLucidUrl(href: string): LucidRef | null {
  const u = lucidUrl(href);
  if (!u) return null;
  const s = segments(u);

  if (s[0] === "publicSegments") {
    if (u.hostname.toLowerCase() !== "lucid.app") return null;
    if (s.length !== 4 || s[1] !== "view" || s[3] !== "image.png" || !UUID.test(s[2])) return null;
    return { kind: "image", publicId: s[2].toLowerCase(), href: u.href };
  }

  let id: string | undefined;
  let product: LucidProduct;
  if (PRODUCTS.has(s[0]) && s.length >= 3 && PRODUCT_ACTIONS.has(s[2])) {
    id = s[1];
    product = s[0] as LucidProduct;
  } else if (s[0] === "documents" && s.length >= 3 && DOCUMENT_VERBS.has(s[1])) {
    id = s[2];
    product = "unknown";
  } else {
    return null;
  }
  if (!UUID.test(id)) return null;

  const ref: LucidDocumentRef = { kind: "document", id: id.toLowerCase(), product, href: u.href };
  const invitationId = u.searchParams.get("invitationId");
  if (invitationId) ref.invitationId = invitationId;
  return ref;
}

function invitationQuery(ref: LucidDocumentRef): string {
  return ref.invitationId ? `?${new URLSearchParams({ invitationId: ref.invitationId })}` : "";
}

/** The frameable viewer: `https://lucid.app/documents/embedded/<id>[?invitationId=…]`. */
export function embedUrl(ref: LucidDocumentRef): string {
  return `${LUCID_ORIGIN}/documents/embedded/${ref.id}${invitationQuery(ref)}`;
}

/** `https://lucid.app/<lucidchart|lucidspark>/<id>/edit[?invitationId=…]`. */
function canonicalEditUrl(ref: LucidDocumentRef): string {
  const product = ref.product === "lucidspark" ? "lucidspark" : "lucidchart";
  return `${LUCID_ORIGIN}/${product}/${ref.id}/edit${invitationQuery(ref)}`;
}

/** A lucid.app `/<product>/<id>/<action>` link, as a URL, or null. */
function productLink(ref: LucidDocumentRef): URL | null {
  const u = new URL(ref.href);
  return u.hostname === "lucid.app" && PRODUCTS.has(segments(u)[0]) ? u : null;
}

/**
 * Where Edit goes. A lucid.app `/<product>/<id>/edit` link is used as written
 * (keeping `page`, `viewport_loc`, the invitation and the fragment); a `/view`
 * or `/comment` one becomes `/edit` with the rest kept. Anything else (the
 * embed viewer, `/documents/…`, legacy hosts) gets the canonical edit link.
 */
export function editUrl(ref: LucidDocumentRef): string {
  const u = productLink(ref);
  if (!u) return canonicalEditUrl(ref);
  const s = u.pathname.split("/");
  // ["", product, id, action, …]
  if (s[3] !== "edit") {
    s[3] = "edit";
    u.pathname = s.join("/");
  }
  return u.href;
}

/**
 * Where "Open in Lucidchart" goes: a lucid.app view, edit or comment link as
 * written, the image itself for a published image, else the edit link.
 */
export function openUrl(ref: LucidRef): string {
  if (ref.kind === "image") return ref.href;
  const u = new URL(ref.href);
  if (u.hostname === "lucid.app") {
    const s = segments(u);
    if (PRODUCTS.has(s[0]) || (s[0] === "documents" && OPENABLE_VERBS.has(s[1]))) return ref.href;
  }
  return canonicalEditUrl(ref);
}

/** `https://lucid.app/publicSegments/view/<id>/image.png`. Throws on a non-UUID id. */
export function publishedImageUrl(publicId: string): string {
  if (!UUID.test(publicId)) throw new Error(`Not a Lucid image id: ${publicId}`);
  return `${LUCID_ORIGIN}/publicSegments/view/${publicId.toLowerCase()}/image.png`;
}

/** The recommended Markdown: the published image, linked to the document's edit URL. */
export function publishedImageMarkdown(title: string, publicId: string, ref: LucidDocumentRef): string {
  const alt = title.replace(/[\\[\]]/g, (c) => `\\${c}`);
  return `[![${alt}](${publishedImageUrl(publicId)})](${editUrl(ref)})`;
}
