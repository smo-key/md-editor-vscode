/**
 * Pictures for the Word export (src/docx.ts), made here because only the
 * webview can draw: Mermaid diagrams, and images Word can't take as they are
 * (SVG, draw.io, WebP…). Each comes as SVG and/or PNG with its size; an SVG a
 * canvas can't draw (one with HTML inside, such as many draw.io files) comes
 * without a PNG, and Word shows the SVG.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

import type { ExportAsset } from "../src/protocol";
import { exportMermaidSvg } from "./markdown/mermaid";

const MAX_PX = 2400;

function svgSize(svg: string): { w: number; h: number } | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.documentElement;
  const vb = el.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const num = (v: string | null) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : NaN);
  const w = num(el.getAttribute("width"));
  const h = num(el.getAttribute("height"));
  if (w > 0 && h > 0) return { w, h };
  if (vb && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) return { w: vb[2]!, h: vb[3]! };
  return null;
}

/** `svg` with explicit pixel width and height (an image needs them to draw at size). */
function sized(svg: string, w: number, h: number): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.documentElement;
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  el.removeAttribute("style");
  return new XMLSerializer().serializeToString(el);
}

/** Draw an image URL to PNG bytes at up to 2× its size, or null when the canvas refuses (tainted). */
async function toPng(url: string, w: number, h: number): Promise<Uint8Array | null> {
  const img = new Image();
  img.decoding = "sync";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scale = Math.min(2, MAX_PX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const b64 = (text: string) => btoa(unescape(encodeURIComponent(text)));

async function svgAsset(svg: string): Promise<ExportAsset | null> {
  const size = svgSize(svg);
  if (!size) return null;
  const text = sized(svg, size.w, size.h);
  const png = await toPng(`data:image/svg+xml;base64,${b64(text)}`, size.w, size.h);
  return { svg: text, png: png ?? undefined, width: size.w, height: size.h };
}

/** An image of the document, by its displayed URL: SVG and other formats Word lacks are converted. */
async function imageAsset(displayUrl: string): Promise<ExportAsset | null> {
  let res: Response;
  try {
    res = await fetch(displayUrl);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const blob = await res.blob();
  const isSvg = blob.type.includes("svg") || /\.svg($|[?#])/i.test(displayUrl);
  if (isSvg) return svgAsset(await blob.text());
  if (/image\/(png|jpeg|gif)/.test(blob.type)) return null; // Word takes these as they are.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const png = await toPng(url, img.naturalWidth, img.naturalHeight);
    return png ? { png, width: img.naturalWidth, height: img.naturalHeight } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Every Mermaid diagram (in document order) and every converted image (by `src` as written). */
export async function collectExportAssets(
  doc: ProseNode,
  displayUrl: (src: string) => string | Promise<string>,
): Promise<{ images: Record<string, ExportAsset>; diagrams: (ExportAsset | null)[] }> {
  const srcs = new Set<string>();
  const diagrams: string[] = [];
  doc.descendants((node) => {
    if ((node.type.name === "image" || node.type.name === "image-block") && node.attrs.src) srcs.add(String(node.attrs.src));
    if (node.type.name === "code_block" && String(node.attrs.language).toLowerCase() === "mermaid") diagrams.push(node.textContent);
    return true;
  });
  const images: Record<string, ExportAsset> = {};
  await Promise.all(
    [...srcs].map(async (src) => {
      const asset = await imageAsset(await displayUrl(src)).catch(() => null);
      if (asset) images[src] = asset;
    }),
  );
  const rendered: (ExportAsset | null)[] = [];
  for (const code of diagrams) {
    const svg = code.trim() ? await exportMermaidSvg(code) : null;
    rendered.push(svg ? await svgAsset(svg) : null);
  }
  return { images, diagrams: rendered };
}
