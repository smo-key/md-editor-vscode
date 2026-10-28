/**
 * Click-to-zoom overlay for images and Mermaid diagrams.
 *
 * Opens fitted to the window (never enlarged past 100%). Then:
 * - pinch (trackpad or touch), the scroll wheel, or + / − zoom around the
 *   pointer; 0 fits again;
 * - clicking the picture toggles between fitted and 100% (around the click),
 *   or 2× for a picture already shown at full size;
 * - dragging pans a zoomed picture;
 * - the × in the top right corner, Esc, or a click outside the picture closes.
 */
export type LightboxContent = { kind: "img"; src: string; alt: string } | { kind: "svg"; svg: string };

/** The picture's placement: screen = offset + scale × picture coordinates. */
export interface View {
  scale: number;
  x: number;
  y: number;
}

const MARGIN = 32;

/** The scale that fits `w`×`h` in the stage (with a margin), never above 1. */
export function fitScale(w: number, h: number, stageW: number, stageH: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.min(1, (stageW - 2 * MARGIN) / w, (stageH - 2 * MARGIN) / h);
}

/** Scale limits for a picture whose fitted scale is `fit`. */
export function scaleLimits(fit: number): [number, number] {
  return [Math.min(fit, 1) / 2, Math.max(8, fit * 8)];
}

/** `view` zoomed to `scale` (clamped) keeping the stage point (`cx`, `cy`) still. */
export function zoomTo(view: View, scale: number, cx: number, cy: number, fit: number): View {
  const [min, max] = scaleLimits(fit);
  const s = Math.min(max, Math.max(min, scale));
  const k = s / view.scale;
  return { scale: s, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

/**
 * Keep the picture on screen: centred on an axis where it is smaller than the
 * stage, otherwise with no gap between its edge and the stage's.
 */
export function clampView(view: View, w: number, h: number, stageW: number, stageH: number): View {
  const axis = (pos: number, size: number, stage: number) => {
    const scaled = size * view.scale;
    if (scaled <= stage) return (stage - scaled) / 2;
    return Math.min(0, Math.max(stage - scaled, pos));
  };
  return { scale: view.scale, x: axis(view.x, w, stageW), y: axis(view.y, h, stageH) };
}

/** The fitted, centred view. */
export function fittedView(w: number, h: number, stageW: number, stageH: number): View {
  const scale = fitScale(w, h, stageW, stageH);
  return { scale, x: (stageW - w * scale) / 2, y: (stageH - h * scale) / 2 };
}

const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

interface Open {
  el: HTMLElement;
  cleanup: () => void;
  restoreFocus: Element | null;
}

let open: Open | null = null;

export function isLightboxOpen(): boolean {
  return open !== null;
}

export function closeLightbox(): void {
  if (!open) return;
  const { el, cleanup, restoreFocus } = open;
  open = null;
  cleanup();
  el.remove();
  if (restoreFocus instanceof HTMLElement) restoreFocus.focus({ preventScroll: true });
}

/** The picture's own size in CSS pixels. */
function naturalSize(content: HTMLElement): { w: number; h: number } {
  if (content instanceof HTMLImageElement) return { w: content.naturalWidth, h: content.naturalHeight };
  const svg = content.querySelector("svg");
  const box = svg?.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { w: box.width, h: box.height };
  const w = Number(svg?.getAttribute("width")) || content.offsetWidth;
  const h = Number(svg?.getAttribute("height")) || content.offsetHeight;
  return { w, h };
}

export function showLightbox(content: LightboxContent): void {
  closeLightbox();
  const el = document.createElement("div");
  el.className = "ken-lightbox";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", content.kind === "img" ? content.alt || "Image" : "Diagram");
  el.tabIndex = -1;

  let picture: HTMLElement;
  if (content.kind === "img") {
    const img = document.createElement("img");
    img.src = content.src;
    img.alt = content.alt;
    img.draggable = false;
    picture = img;
  } else {
    const box = document.createElement("div");
    box.className = "ken-lightbox-svg";
    // Already sanitised: Mermaid renders with securityLevel "strict".
    box.innerHTML = content.svg;
    const svg = box.querySelector("svg");
    // Mermaid caps its width inline; here the box sets the size.
    if (svg) svg.style.maxWidth = "none";
    picture = box;
  }
  picture.classList.add("ken-lightbox-picture");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ken-lightbox-close";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close (Esc)");
  close.innerHTML = CLOSE_ICON;
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });

  const level = document.createElement("div");
  level.className = "ken-lightbox-level";
  level.setAttribute("aria-live", "polite");

  el.append(picture, close, level);
  document.body.append(el);

  let size = { w: 0, h: 0 };
  let view: View = { scale: 1, x: 0, y: 0 };
  let fit = 1;
  let atFit = true;
  const stage = () => ({ w: el.clientWidth || window.innerWidth, h: el.clientHeight || window.innerHeight });

  const apply = () => {
    const s = stage();
    view = clampView(view, size.w, size.h, s.w, s.h);
    picture.style.width = `${size.w}px`;
    picture.style.height = `${size.h}px`;
    picture.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    level.textContent = `${Math.round(view.scale * 100)}%`;
    el.dataset.zoomed = String(view.scale > fit + 0.001);
    el.dataset.fitted = String(atFit);
  };
  const refit = () => {
    const s = stage();
    size = naturalSize(picture);
    fit = fitScale(size.w, size.h, s.w, s.h);
    view = fittedView(size.w, size.h, s.w, s.h);
    atFit = true;
    apply();
  };
  const zoom = (scale: number, cx: number, cy: number) => {
    view = zoomTo(view, scale, cx, cy, fit);
    atFit = Math.abs(view.scale - fit) < 0.001;
    apply();
  };
  const stagePoint = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPicture = (x: number, y: number) =>
    x >= view.x && y >= view.y && x <= view.x + size.w * view.scale && y <= view.y + size.h * view.scale;

  if (picture instanceof HTMLImageElement && !picture.complete) picture.addEventListener("load", refit, { once: true });
  refit();

  // Wheel: a trackpad pinch arrives as a wheel event with ctrlKey and small
  // deltas; a mouse wheel or two-finger scroll without it, larger.
  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = stagePoint(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const delta = e.deltaY * unit;
      zoom(view.scale * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
    },
    { passive: false },
  );

  // Pointers: one drags (pans), two pinch (touch screens); a press that
  // barely moves is a click.
  const pointers = new Map<number, { x: number; y: number }>();
  let press: { x: number; y: number; moved: boolean; view: View } | null = null;
  let pinch: { dist: number; scale: number } | null = null;
  const distance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".ken-lightbox-close")) return;
    const p = stagePoint(e);
    pointers.set(e.pointerId, p);
    el.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2) {
      pinch = { dist: distance(), scale: view.scale };
      press = null;
    } else if (pointers.size === 1) press = { x: p.x, y: p.y, moved: false, view };
  });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = stagePoint(e);
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoom(pinch.scale * (distance() / (pinch.dist || 1)), (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      return;
    }
    if (!press) return;
    if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) < 4) return;
    press.moved = true;
    el.classList.add("ken-lightbox-panning");
    view = { scale: view.scale, x: press.view.x + p.x - press.x, y: press.view.y + p.y - press.y };
    apply();
  });
  const release = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    el.classList.remove("ken-lightbox-panning");
    if (pointers.size < 2) pinch = null;
    const was = press;
    press = null;
    if (e.type !== "pointerup" || !was || was.moved || pointers.size > 0) return;
    // A click: on the picture it toggles the zoom, outside it closes.
    if (!onPicture(was.x, was.y)) {
      closeLightbox();
      return;
    }
    if (atFit) zoom(fit < 1 ? 1 : Math.max(2, fit * 2), was.x, was.y);
    else refit();
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  // The pointer handlers decide: the click must not reach the editor behind.
  el.addEventListener("click", (e) => e.stopPropagation());

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const s = stage();
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "+" || e.key === "=") zoom(view.scale * 1.25, s.w / 2, s.h / 2);
    else if (e.key === "-" || e.key === "_") zoom(view.scale / 1.25, s.w / 2, s.h / 2);
    else if (e.key === "0") refit();
    else if (e.key === "Tab") {
      // Focus stays in the dialog.
      e.preventDefault();
      close.focus();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onResize = () => (atFit ? refit() : apply());
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);

  open = {
    el,
    restoreFocus: document.activeElement,
    cleanup: () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    },
  };
  // Keys go to the dialog, not the document behind it.
  el.focus({ preventScroll: true });
}
