/**
 * "Heading numbering": the dialog that sets a document's own heading
 * numbering, as its `ken-heading-numbering` property (src/headingNumbers.ts).
 *
 * It edits a `NumberingChoice` (editor settings / on with these levels / off)
 * and hands the property's new value to `onApply`: `null` removes it. It
 * reads and writes no document itself; main.ts saves the value through the
 * Properties panel, so only that one frontmatter line changes.
 *
 * Under "On", a preset fills in every level (style, parents, prefix) and the
 * separator; editing any of them shows the preset as "Custom".
 *
 * A modal like the shortcut list (shortcutsPanel.ts): Escape or Cancel closes
 * it without writing, Tab stays inside it, and focus goes back where it was.
 */
import {
  formatNumberingProperty,
  HEADING_NUMBER_PARENTS,
  HEADING_NUMBER_PRESET_NAMES,
  HEADING_NUMBER_STYLES,
  headingNumberLabels,
  numberingChoice,
  prefixProblem,
  presetLevels,
  presetOf,
  separatorProblem,
  type HeadingNumberParents,
  type HeadingNumberPreset,
  type HeadingNumbersConfig,
  type HeadingNumberStyle,
  type NumberingChoice,
  type NumberingLevels,
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
  "decimal-leading-zero": "01, 02, 03",
  "lower-alpha": "a, b, c",
  "upper-alpha": "A, B, C",
  "lower-roman": "i, ii, iii",
  "upper-roman": "I, II, III",
  "parenthesized-decimal": "(1), (2), (3)",
  "parenthesized-lower-alpha": "(a), (b), (c)",
  "parenthesized-upper-alpha": "(A), (B), (C)",
  "parenthesized-lower-roman": "(i), (ii), (iii)",
  "parenthesized-upper-roman": "(I), (II), (III)",
  "decimal-paren": "1), 2), 3)",
  "lower-alpha-paren": "a), b), c)",
  "upper-alpha-paren": "A), B), C)",
  "lower-roman-paren": "i), ii), iii)",
  "upper-roman-paren": "I), II), III)",
  none: "None",
};

const PARENTS_LABELS: Record<HeadingNumberParents, [string, string]> = {
  auto: ["Auto", "Only its own label for a parenthesized style, else with its parents"],
  full: ["With parents", "Parent numbers, then this level's: 1.a.i, or 1.01(a)"],
  legal: ["Letters as digits", "Parent numbers, with plain letters and roman numerals as digits, as Word's legal style: Section 1.01 under Article I"],
  own: ["Own only", "Only this level's own label: (a)"],
};

const PRESET_LABELS: Record<HeadingNumberPreset | "custom", string> = {
  outline: "Outline (1, 1.a, 1.a.i)",
  decimal: "Decimal (1, 1.1, 1.1.1)",
  legal: "Legal (1.1.1, (a), (i), (A))",
  "legal-full": "Legal, full path (1.1.1, 1.1.1(a), 1.1.1(a)(i))",
  "legal-article": "Legal: Article, Section (I, 1.01, (a))",
  "legal-article-full": "Legal: Article, Section, full path (I, 1.01, 1.01(a))",
  custom: "Custom",
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

function select<T extends string>(id: string, values: readonly T[], label: (v: T) => string, title?: (v: T) => string): HTMLSelectElement {
  const el = document.createElement("select");
  el.id = id;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label(value);
    if (title) option.title = title(value);
    el.append(option);
  }
  return el;
}

export function openHeadingNumberingDialog(options: HeadingNumberingDialogOptions): void {
  closeHeadingNumberingDialog();
  restoreFocus = document.activeElement as HTMLElement | null;
  const { settings } = options;
  const start = numberingChoice(options.property, settings);
  let mode: Mode = start.choice.mode;
  // The levels the "On" choice edits: the document's, else the settings'.
  const levels: NumberingLevels =
    start.choice.mode === "on"
      ? { styles: [...start.choice.styles], parents: [...start.choice.parents], prefixes: [...start.choice.prefixes], separator: start.choice.separator }
      : { styles: [...settings.styles], parents: [...settings.parents], prefixes: [...settings.prefixes], separator: settings.separator };

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
  title.title = "For this document only, saved as its ken-heading-numbering property. Numbers are never written into the text.";
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

  const presetRow = document.createElement("div");
  presetRow.className = "ken-numbering-preset-row";
  const presetLabel = document.createElement("label");
  presetLabel.htmlFor = `${id}-preset`;
  presetLabel.textContent = "Preset";
  const preset = select(`${id}-preset`, [...HEADING_NUMBER_PRESET_NAMES, "custom"] as const, (v) => PRESET_LABELS[v]);
  preset.classList.add("ken-numbering-preset");
  preset.addEventListener("change", () => {
    // Custom keeps the fields as they are, ready to edit.
    if (preset.value === "custom") return;
    Object.assign(levels, presetLevels(preset.value as HeadingNumberPreset));
    refresh();
  });
  presetRow.append(presetLabel, preset);
  body.append(presetRow);

  const grid = document.createElement("div");
  grid.className = "ken-numbering-levels";
  for (const heading of ["", "Style", "Parents", "Prefix"]) {
    const h = document.createElement("span");
    h.className = "ken-dialog-label";
    h.textContent = heading;
    grid.append(h);
  }
  const styleSelects: HTMLSelectElement[] = [];
  const parentSelects: HTMLSelectElement[] = [];
  const prefixInputs: HTMLInputElement[] = [];
  for (let i = 0; i < 6; i++) {
    const label = document.createElement("label");
    label.htmlFor = `${id}-h${i + 1}`;
    label.textContent = `H${i + 1}`;
    const style = select(`${id}-h${i + 1}`, HEADING_NUMBER_STYLES, (v) => STYLE_LABELS[v]);
    style.dataset.level = String(i + 1);
    style.addEventListener("change", () => {
      levels.styles[i] = style.value as HeadingNumberStyle;
      refresh();
    });
    const parents = select(
      `${id}-h${i + 1}-parents`,
      HEADING_NUMBER_PARENTS,
      (v) => PARENTS_LABELS[v][0],
      (v) => PARENTS_LABELS[v][1],
    );
    parents.dataset.parents = String(i + 1);
    parents.setAttribute("aria-label", `H${i + 1} parent numbers`);
    parents.addEventListener("change", () => {
      levels.parents[i] = parents.value as HeadingNumberParents;
      refresh();
    });
    const prefix = document.createElement("input");
    prefix.type = "text";
    prefix.dataset.prefix = String(i + 1);
    prefix.spellcheck = false;
    prefix.maxLength = 24;
    prefix.placeholder = i === 0 ? "Article " : i === 1 ? "Section " : "";
    prefix.setAttribute("aria-label", `H${i + 1} prefix`);
    prefix.addEventListener("input", () => {
      levels.prefixes[i] = prefix.value;
      refresh();
    });
    styleSelects.push(style);
    parentSelects.push(parents);
    prefixInputs.push(prefix);
    grid.append(label, style, parents, prefix);
  }
  body.append(grid);

  const sepRow = document.createElement("div");
  sepRow.className = "ken-numbering-preset-row";
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
    levels.separator = sepInput.value;
    refresh();
  });
  sepRow.append(sepLabel, sepInput);
  body.append(sepRow);

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
  foot.append(cancel, apply);

  el.append(head, body, foot);
  shade.append(el);

  function choice(): NumberingChoice {
    if (mode === "on") return { mode, styles: [...levels.styles], parents: [...levels.parents], prefixes: [...levels.prefixes], separator: levels.separator };
    return { mode };
  }

  function refresh() {
    const editable = mode === "on";
    // "Editor settings" shows what the settings say; "Off" keeps the levels
    // for when it's turned back on.
    const shown: NumberingLevels = mode === "settings" ? settings : levels;
    preset.value = presetOf(shown);
    preset.disabled = !editable;
    for (let i = 0; i < 6; i++) {
      styleSelects[i]!.value = shown.styles[i]!;
      parentSelects[i]!.value = shown.parents[i]!;
      if (prefixInputs[i]!.value !== shown.prefixes[i]) prefixInputs[i]!.value = shown.prefixes[i]!;
      styleSelects[i]!.disabled = parentSelects[i]!.disabled = prefixInputs[i]!.disabled = !editable;
    }
    if (sepInput.value !== shown.separator) sepInput.value = shown.separator;
    sepInput.disabled = !editable;
    const problem = editable
      ? (separatorProblem(levels.separator) ?? levels.prefixes.map(prefixProblem).find((p): p is string => !!p) ?? null)
      : null;
    error.textContent = problem ?? "";
    error.hidden = !problem;
    apply.disabled = !!problem;
    const config: HeadingNumbersConfig =
      mode === "settings" ? settings : mode === "off" ? { ...settings, enabled: false } : { enabled: true, ...levels };
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
