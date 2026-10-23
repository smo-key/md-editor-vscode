/**
 * TEMPORARY local copy of the Lucid URL parser (spec §6.2), so the preview
 * plugin builds before `src/lucidUrl.ts` (WP2, branch feat/lucid-host) is on
 * main. REPLACE: delete this file and import `../../src/lucidUrl` instead.
 * Only the parts the webview needs are here.
 */
export type LucidProduct = "lucidchart" | "lucidspark" | "unknown";
export type LucidRef =
  | { kind: "document"; id: string; product: LucidProduct; invitationId?: string; href: string }
  | { kind: "image"; publicId: string; href: string };

export const LUCID_HOSTS = ["lucid.app", "www.lucidchart.com", "lucidchart.com", "app.lucidchart.com"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLucidUrl(href: string): LucidRef | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  if (!LUCID_HOSTS.includes(host)) return null;
  const seg = url.pathname.split("/").filter(Boolean);
  const invitationId = url.searchParams.get("invitationId") ?? undefined;
  const doc = (id: string | undefined, product: LucidProduct): LucidRef | null =>
    id && UUID.test(id)
      ? { kind: "document", id: id.toLowerCase(), product, ...(invitationId ? { invitationId } : {}), href }
      : null;
  if ((seg[0] === "lucidchart" || seg[0] === "lucidspark") && ["edit", "view", "comment"].includes(seg[2] ?? "")) {
    return doc(seg[1], seg[0]);
  }
  if (seg[0] === "documents" && ["edit", "view", "comment", "embedded", "embeddedchart"].includes(seg[1] ?? "")) {
    return doc(seg[2], "unknown");
  }
  if (host === "lucid.app" && seg[0] === "publicSegments" && seg[1] === "view" && seg[3] === "image.png" && seg.length === 4) {
    return seg[2] && UUID.test(seg[2]) ? { kind: "image", publicId: seg[2].toLowerCase(), href } : null;
  }
  return null;
}

export function embedUrl(ref: LucidRef & { kind: "document" }): string {
  const q = ref.invitationId ? `?invitationId=${encodeURIComponent(ref.invitationId)}` : "";
  return `https://lucid.app/documents/embedded/${ref.id}${q}`;
}
