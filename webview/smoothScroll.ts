/** Scroll `el` to `top` quickly (the browser's own smooth scrolling takes too long to step through changes). */
export function scrollQuickly(el: HTMLElement, top: number, ms = 160): void {
  const start = el.scrollTop;
  const delta = top - start;
  if (Math.abs(delta) < 1 || ms <= 0) {
    el.scrollTop = top;
    return;
  }
  const t0 = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    // Ease out: fast start, gentle stop.
    el.scrollTop = start + delta * (1 - Math.pow(1 - t, 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The nearest scrolling ancestor of `el`. */
export function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}
