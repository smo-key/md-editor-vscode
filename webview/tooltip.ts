/**
 * Tooltips for the bottom toolbar: the action in bold, then its keyboard
 * shortcut (if one is assigned) as a keycap. Any element with
 * `data-tooltip` gets one; `data-tooltip-key` adds the shortcut.
 *
 * Shown after a short delay on hover (immediately when moving between
 * buttons while one is already showing) and on keyboard focus; hidden on
 * leave, click, scroll or blur. Native `title` tooltips are not used, so
 * there is never a second, unstyled one.
 */

const DELAY_MS = 450;
/** Moving to another button this soon after a tooltip hides shows the next at once. */
const WARM_MS = 300;

let tip: HTMLElement | null = null;
let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;

/** Set (or update) an element's tooltip. An empty key means no shortcut. */
export function setTooltip(el: HTMLElement, label: string, key = ""): void {
  el.dataset.tooltip = label;
  if (key) el.dataset.tooltipKey = key;
  else delete el.dataset.tooltipKey;
  el.removeAttribute("title");
  if (current === el && tip) render(el);
}

function ensureTip(): HTMLElement {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "ken-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.id = "ken-tooltip";
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function render(el: HTMLElement): void {
  const t = ensureTip();
  t.replaceChildren();
  const label = document.createElement("strong");
  label.className = "ken-tooltip-label";
  label.textContent = el.dataset.tooltip ?? "";
  t.append(label);
  const key = el.dataset.tooltipKey;
  if (key) {
    const kbd = document.createElement("kbd");
    kbd.className = "ken-tooltip-key";
    kbd.textContent = key;
    t.append(kbd);
  }
}

function position(el: HTMLElement): void {
  const t = ensureTip();
  const anchor = el.getBoundingClientRect();
  const box = t.getBoundingClientRect();
  const left = Math.max(4, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - 4));
  // Away from the window edge the toolbar sits on: above a bottom toolbar,
  // below a top one (and below whenever there is no room above).
  const atTop = document.body.dataset.toolbar === "top";
  const above = anchor.top - box.height - 8;
  const top = !atTop && above >= 4 ? above : anchor.bottom + 8;
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
}

export function showTooltip(el: HTMLElement): void {
  clearTimeout(timer);
  current = el;
  render(el);
  const t = ensureTip();
  t.hidden = false;
  position(el);
  el.setAttribute("aria-describedby", t.id);
}

export function hideTooltip(): void {
  clearTimeout(timer);
  if (current) current.removeAttribute("aria-describedby");
  if (tip && !tip.hidden) hiddenAt = performance.now();
  if (tip) tip.hidden = true;
  current = null;
}

function target(e: Event): HTMLElement | null {
  const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]");
  return el ?? null;
}

/** Wire tooltips for every `[data-tooltip]` element inside `root`. */
export function installTooltips(root: HTMLElement): () => void {
  const over = (e: MouseEvent) => {
    const el = target(e);
    if (!el || el === current) return;
    clearTimeout(timer);
    const warm = (tip && !tip.hidden) || performance.now() - hiddenAt < WARM_MS;
    if (warm) showTooltip(el);
    else {
      current = el;
      timer = setTimeout(() => current === el && showTooltip(el), DELAY_MS);
    }
  };
  const out = (e: MouseEvent) => {
    const el = target(e);
    if (!el) return;
    const to = e.relatedTarget as Node | null;
    if (to && el.contains(to)) return;
    hideTooltip();
  };
  const focus = (e: FocusEvent) => {
    const el = target(e);
    if (el && el.matches(":focus-visible")) showTooltip(el);
  };
  const hide = () => hideTooltip();
  root.addEventListener("mouseover", over);
  root.addEventListener("mouseout", out);
  root.addEventListener("focusin", focus);
  root.addEventListener("focusout", hide);
  root.addEventListener("mousedown", hide);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  return () => {
    root.removeEventListener("mouseover", over);
    root.removeEventListener("mouseout", out);
    root.removeEventListener("focusin", focus);
    root.removeEventListener("focusout", hide);
    root.removeEventListener("mousedown", hide);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("blur", hide);
    hideTooltip();
  };
}
