/**
 * "Heading numbering": the dialog that sets a document's own heading
 * numbering, as its `ken-heading-numbering` property (src/headingNumbers.ts).
 *
 * It edits a `NumberingChoice` (editor settings / on with these styles / off)
 * and hands the property's new value to `onApply`: `null` removes it. It
 * reads and writes no document itself; main.ts saves the value through the
 * Properties panel, so only that one frontmatter line changes.
 *
 * A modal like the shortcut list (shortcutsPanel.ts): Escape or Cancel closes
 * it without writing, Tab stays inside it, and focus goes back where it was.
 */
import {
  formatNumberingProperty,
  HEADING_NUMBER_STYLES,
  headingNumberLabels,
  numberingChoice,
  separatorProblem,
  type HeadingNumbersConfig,
  type HeadingNumberStyle,
  type NumberingChoice,
} from "../src/headingNumbers";

export interface HeadingNumberingDialogOptions {
  /** The editor settings (`kenMarkdown.headingNumbers.*`). */
  settings: HeadingNumbersConfig;
  /** The document's `ken-heading-numbering` value as written, if any. */
  property: string | undefined;
  /** The property's new value (YAML text), or null to remove it. */
  onApply: (value: string | null) => void;
}

const STYLE_LABELS: Record<HeadingNumberStyle, string> = {
  decimal: "1, 2, 3",
  "lower-alpha": "a, b, c",
  "upper-alpha": "A, B, C",
  "lower-roman": "i, ii, iii",
  "upper-roman": "I, II, III",
  none: "None",
};

type Mode = NumberingChoice["mode"];

const MODES: [Mode, string][] = [
  ["settings", "Use editor settings (default)"],
  ["on", "On"],
  ["off", "Off"],
];

let backdrop: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;

export function isHeadingNumberingDialogOpen(): boolean {
  return !!backdrop;
}

export function closeHeadingNumberingDialog(): void {
  if (!backdrop) return;
  backdrop.remove();
  backdrop = null;
  restoreFocus?.focus?.();
  restoreFocus = null;
}

/** "1 · 1.a · 1.a.i…" for a config, or "Off". */
export function numberingPreview(config: HeadingNumbersConfig): string {
  if (!config.enabled) return "Off";
  const labels = headingNumberLabels([1, 2, 3, 4, 5, 6], config).filter((l): l is string => !!l);
  return labels.length ? labels.join(" · ") : "No levels numbered";
}

let ids = 0;

export function openHeadingNumberingDialog(options: HeadingNumberingDialogOptions): void {
  closeHeadingNumberingDialog();
  restoreFocus = document.activeElement as HTMLElement | null;
  const { settings } = options;
  const start = numberingChoice(options.property, settings);
  let mode: Mode = start.choice.mode;
  // The styles the "On" choice edits: the document's, else the settings'.
  const styles: HeadingNumberStyle[] = start.choice.mode === "on" ? [...start.choice.styles] : [...settings.styles];
  let separator = start.choice.mode === "on" ? start.choice.separator : settings.separator;

  const id = `ken-numbering-${++ids}`;
  const shade = document.createElement("div");
  shade.className = "ken-dialog-backdrop";
  shade.addEventListener("mousedown", (e) => {
    if (e.target === shade) closeHeadingNumberingDialog();
  });

  const el = document.createElement("div");
  el.className = "ken-dialog ken-numbering-dialog";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", `${id}-title`);

  const head = document.createElement("header");
  const title = document.createElement("h2");
  title.id = `${id}-title`;
  title.textContent = "Heading numbering";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ken-dialog-close";
  close.textContent = "×";
  close.title = "Cancel (Esc)";
  close.setAttribute("aria-label", "Cancel");
  close.addEventListener("click", () => closeHeadingNumberingDialog());
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "ken-dialog-body";

  const intro = document.createElement("p");
  intro.className = "ken-dialog-note";
  intro.textContent = "For this document only. Saved as the ken-heading-numbering property; numbers are never written into the text.";
  body.append(intro);

  if (start.invalid) {
    const warning = document.createElement("p");
    warning.className = "ken-numbering-warning";
    warning.textContent = `The document's value ${options.property?.trim()} isn't valid, so the editor settings apply.`;
    body.append(warning);
  }

  const modes = document.createElement("div");
  modes.className = "ken-numbering-modes";
  modes.setAttribute("role", "radiogroup");
  modes.setAttribute("aria-label", "Numbering");
  const radios: HTMLInputElement[] = [];
  for (const [value, label] of MODES) {
    const wrap = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `${id}-mode`;
    input.value = value;
    input.checked = value === mode;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      mode = value;
      refresh();
    });
    radios.push(input);
    wrap.append(input, document.createTextNode(label));
    modes.append(wrap);
  }
  body.append(modes);

  const grid = document.createElement("div");
  grid.className = "ken-numbering-levels";
  const selects: HTMLSelectElement[] = [];
  for (let i = 0; i < 6; i++) {
    const label = document.createElement("label");
    label.htmlFor = `${id}-h${i + 1}`;
    label.textContent = `H${i + 1}`;
    const select = document.createElement("select");
    select.id = `${id}-h${i + 1}`;
    select.dataset.level = String(i + 1);
    for (const style of HEADING_NUMBER_STYLES) {
      const option = document.createElement("option");
      option.value = style;
      option.textContent = STYLE_LABELS[style];
      select.append(option);
    }
    select.addEventListener("change", () => {
      styles[i] = select.value as HeadingNumberStyle;
      refresh();
    });
    selects.push(select);
    grid.append(label, select);
  }
  const sepLabel = document.createElement("label");
  sepLabel.htmlFor = `${id}-sep`;
  sepLabel.textContent = "Separator";
  const sepInput = document.createElement("input");
  sepInput.id = `${id}-sep`;
  sepInput.className = "ken-numbering-separator";
  sepInput.type = "text";
  sepInput.spellcheck = false;
  sepInput.maxLength = 8;
  sepInput.addEventListener("input", () => {
    separator = sepInput.value;
    refresh();
  });
  grid.append(sepLabel, sepInput);
  body.append(grid);

  const error = document.createElement("p");
  error.className = "ken-numbering-error";
  error.setAttribute("role", "alert");

  const previewBox = document.createElement("div");
  previewBox.className = "ken-numbering-preview-box";
  const previewLabel = document.createElement("span");
  previewLabel.className = "ken-dialog-label";
  previewLabel.textContent = "Preview";
  const preview = document.createElement("span");
  preview.className = "ken-numbering-preview";
  preview.setAttribute("aria-live", "polite");
  previewBox.append(previewLabel, preview);
  body.append(error, previewBox);

  const foot = document.createElement("footer");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ken-dialog-button secondary ken-dialog-remove";
  remove.textContent = "Remove from document";
  remove.title = "Remove ken-heading-numbering, so the editor settings apply";
  remove.disabled = options.property === undefined;
  remove.addEventListener("click", () => {
    closeHeadingNumberingDialog();
    options.onApply(null);
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ken-dialog-button secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeHeadingNumberingDialog());
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "ken-dialog-button primary";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    if (apply.disabled) return;
    const value = formatNumberingProperty(choice(), settings);
    closeHeadingNumberingDialog();
    // Unchanged (or still absent): nothing to write.
    if (value === (options.property?.trim() ?? null)) return;
    options.onApply(value);
  });
  const spacer = document.createElement("span");
  spacer.className = "ken-dialog-spacer";
  foot.append(remove, spacer, cancel, apply);

  el.append(head, body, foot);
  shade.append(el);

  function choice(): NumberingChoice {
    if (mode === "on") return { mode, styles: [...styles], separator };
    return { mode };
  }

  function refresh() {
    const editable = mode === "on";
    // "Editor settings" shows what the settings say; "Off" keeps the styles
    // for when it's turned back on.
    const shown = mode === "settings" ? settings.styles : styles;
    selects.forEach((s, i) => {
      s.value = shown[i]!;
      s.disabled = !editable;
    });
    sepInput.value = mode === "settings" ? settings.separator : separator;
    sepInput.disabled = !editable;
    const problem = editable ? separatorProblem(separator) : null;
    error.textContent = problem ?? "";
    error.hidden = !problem;
    apply.disabled = !!problem;
    const config: HeadingNumbersConfig =
      mode === "settings" ? settings : mode === "off" ? { ...settings, enabled: false } : { enabled: true, styles, separator };
    preview.textContent = numberingPreview(config);
  }

  const focusables = () =>
    [...el.querySelectorAll<HTMLElement>("button, input, select")].filter(
      (f) => !(f as HTMLButtonElement).disabled && !(f instanceof HTMLInputElement && f.type === "radio" && !f.checked),
    );
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeHeadingNumberingDialog();
      return;
    }
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type === "text") {
      e.preventDefault();
      apply.click();
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === -1 || i === list.length - 1 ? 0 : i + 1;
    e.preventDefault();
    list[next]!.focus();
  });

  refresh();
  document.body.append(shade);
  backdrop = shade;
  (radios.find((r) => r.checked) ?? radios[0])!.focus();
}
