// The image viewer: fitted on open, zoom around the pointer, click toggles
// fitted/100%, × and Esc close.
import { afterEach, describe, expect, it } from "vitest";

import { clampView, closeLightbox, fitScale, fittedView, isLightboxOpen, showLightbox, zoomTo } from "../../webview/lightbox";

describe("lightbox geometry", () => {
  it("fits a large picture with a margin and never enlarges a small one", () => {
    expect(fitScale(2000, 1000, 1064, 864)).toBe(0.5);
    expect(fitScale(100, 100, 1000, 800)).toBe(1);
  });

  it("zooms around a point, which stays still", () => {
    const v = zoomTo({ scale: 1, x: 0, y: 0 }, 2, 100, 50, 1);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    expect(zoomTo(v, 1000, 0, 0, 1).scale).toBe(8);
  });

  it("centres a picture smaller than the stage and keeps a larger one's edges in", () => {
    expect(clampView({ scale: 1, x: 300, y: 0 }, 100, 100, 500, 500)).toEqual({ scale: 1, x: 200, y: 200 });
    expect(clampView({ scale: 2, x: 50, y: -5000 }, 1000, 1000, 500, 500)).toEqual({ scale: 2, x: 0, y: -1500 });
    expect(fittedView(2000, 1000, 1064, 864)).toEqual({ scale: 0.5, x: 32, y: 182 });
  });
});

/** Open an image of `w`×`h` in a `vw`×`vh` window. */
function openImage(w: number, h: number, vw = 1064, vh = 864) {
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => w });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => h });
  Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: vw });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: vh });
  showLightbox({ kind: "img", src: "data:image/png;base64,", alt: "A chart" });
  const el = document.querySelector<HTMLElement>(".ken-lightbox")!;
  const img = el.querySelector<HTMLImageElement>("img")!;
  const level = () => el.querySelector(".ken-lightbox-level")!.textContent;
  const pointer = (type: string, x: number, y: number) =>
    el.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
  const click = (x: number, y: number) => {
    pointer("pointerdown", x, y);
    pointer("pointerup", x, y);
  };
  return { el, img, level, click, pointer };
}

afterEach(() => closeLightbox());

describe("lightbox viewer", () => {
  it("opens fitted, and a click on the picture toggles 100% and back", () => {
    const { img, level, click } = openImage(2000, 1000);
    expect(level()).toBe("50%");
    expect(img.style.transform).toBe("translate(32px, 182px) scale(0.5)");
    click(532, 432);
    expect(level()).toBe("100%");
    click(532, 432);
    expect(level()).toBe("50%");
  });

  it("zooms with the wheel and a trackpad pinch", () => {
    const { el, level } = openImage(2000, 1000);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 500, clientY: 400, bubbles: true, cancelable: true }));
    expect(Number(level()!.replace("%", ""))).toBeGreaterThan(50);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, ctrlKey: true, clientX: 500, clientY: 400, bubbles: true, cancelable: true }));
    expect(Number(level()!.replace("%", ""))).toBeLessThan(50);
  });

  it("pans a zoomed picture by dragging, without toggling the zoom", () => {
    const { img, level, click, pointer } = openImage(2000, 1000);
    click(532, 432);
    const before = img.style.transform;
    pointer("pointerdown", 500, 400);
    pointer("pointermove", 450, 380);
    pointer("pointerup", 450, 380);
    expect(level()).toBe("100%");
    expect(img.style.transform).not.toBe(before);
  });

  it("closes with the × button, with Esc, and with a click outside the picture", () => {
    let { el } = openImage(400, 300);
    const close = el.querySelector<HTMLButtonElement>(".ken-lightbox-close")!;
    expect(close.getAttribute("aria-label")).toBe("Close (Esc)");
    close.click();
    expect(isLightboxOpen()).toBe(false);
    ({ el } = openImage(400, 300));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isLightboxOpen()).toBe(false);
    const { click } = openImage(400, 300);
    click(5, 5);
    expect(isLightboxOpen()).toBe(false);
    void el;
  });
});
