/**
 * Frontmatter, shown as a "Properties" panel above the document.
 *
 * Collapsed (the default) it is one quiet line previewing the key-value
 * pairs; expanded, each pair is an editable row (key, value, remove), with
 * rows to add, a raw YAML view for anything the rows do not suit, and a way to
 * remove the properties altogether. Edits change only the lines they touch
 * (see frontmatterModel.ts) and are saved like any other edit.
 *
 * Values are coloured by YAML type. Fields are textareas over a coloured
 * mirror of their text: the mirror sizes the field, so long values wrap and
 * the YAML view grows with its content instead of scrolling. Frontmatter the
 * rows cannot show faithfully (`rowsUnsupported`) opens as YAML only.
 */
import { ChevronRight, Plus, Settings, Tags, Trash2, TriangleAlert, X, Braces, createElement, type IconNode } from "lucide";

import {
  entries,
  formatFrontmatter,
  parseFrontmatter,
  highlightYaml,
  previewTokens,
  rowsUnsupported,
  setProperty,
  setValueText,
  valueText,
  yamlTokens,
  type FrontEntry,
  type Frontmatter,
  type YamlToken,
} from "./frontmatterModel";

type Change = (front: string) => void;

export interface FrontmatterPanelOptions {
  /** The header's "Heading numbering…" button (shown while expanded). */
  onHeadingNumbering?: () => void;
  /** A warning for a property's value (its YAML text), shown on its row; null for none. */
  propertyWarning?: (key: string, value: string) => string | null;
}

const icon = (node: IconNode, size = 14) => createElement(node, { width: size, height: size, "stroke-width": 1.75 });

/** Append tokens as text, each coloured one in a `ken-yaml-<type>` span. */
function paintTokens(parent: HTMLElement, tokens: YamlToken[]): void {
  for (const t of tokens) {
    if (!t.type) {
      parent.append(t.text);
      continue;
    }
    const span = document.createElement("span");
    span.className = `ken-yaml-${t.type}`;
    span.textContent = t.text;
    parent.append(span);
  }
}

/**
 * A textarea over a coloured mirror of its text. The mirror is in the flow
 * and the textarea covers it, so the field is exactly as tall (and, for keys,
 * as wide) as its wrapped text: it grows while typing and never scrolls.
 */
function mirroredField(
  kind: string,
  text: string,
  placeholder: string,
  colour: (text: string, mirror: HTMLElement) => void,
): { field: HTMLElement; area: HTMLTextAreaElement; repaint: () => void } {
  const field = document.createElement("div");
  field.className = `ken-fm-field ken-fm-${kind}-field`;
  const mirror = document.createElement("div");
  mirror.className = "ken-fm-mirror";
  mirror.setAttribute("aria-hidden", "true");
  const area = document.createElement("textarea");
  area.className = `ken-fm-${kind}`;
  area.value = text;
  area.placeholder = placeholder;
  area.spellcheck = false;
  area.rows = 1;
  const repaint = () => {
    mirror.replaceChildren();
    if (area.value) colour(area.value, mirror);
    else {
      // Keeps an empty field as wide as its placeholder.
      const ph = document.createElement("span");
      ph.className = "ken-fm-mirror-placeholder";
      ph.textContent = placeholder;
      mirror.append(ph);
    }
    // A trailing newline still gets its line.
    mirror.append("\u200b");
  };
  repaint();
  area.addEventListener("input", repaint);
  field.append(mirror, area);
  return { field, area, repaint };
}

let instance: FrontmatterPanel | null = null;

/** Show (adding it if the document has none) and expand the properties. */
export function openFrontmatter(): void {
  instance?.open();
}

export function hasFrontmatterPanel(): boolean {
  return !!instance;
}

export class FrontmatterPanel {
  readonly el: HTMLElement;
  private front = "";
  private model: Frontmatter | null = null;
  private expanded = false;
  private raw = false;
  /** What the last render showed: the YAML view (chosen, or the only one possible). */
  private shownRaw = false;
  private yamlButton: HTMLButtonElement | null = null;
  /** Show the panel even when the document has no frontmatter (setting). */
  private alwaysShow = false;
  /** Opened on a document without frontmatter: a blank row, written once it has a name. */
  private draft = false;

  constructor(
    host: HTMLElement,
    private readonly onChange: Change,
    private readonly options: FrontmatterPanelOptions = {},
  ) {
    this.el = document.createElement("div");
    this.el.className = "ken-frontmatter";
    this.el.hidden = true;
    host.prepend(this.el);
    instance = this;
  }

  /** The document's frontmatter block ("" for none), e.g. after an outside edit. */
  set(front: string): void {
    if (front === this.front && this.model) return;
    this.front = front;
    this.model = front ? parseFrontmatter(front) : null;
    // An outside change while editing a field must not steal the caret.
    if (this.el.contains(document.activeElement) && this.expanded) return;
    this.render();
  }

  /**
   * The frontmatter went back (or forward) to `front` by undo or redo: shown
   * even while a field is being edited, which keeps the focus (the same
   * field, the caret at its end) so undo can go on from there.
   */
  restore(front: string): void {
    const fields = () => [...this.el.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input")];
    const at = fields().indexOf(document.activeElement as HTMLTextAreaElement);
    this.front = front;
    this.model = front ? parseFrontmatter(front) : null;
    this.render();
    if (at < 0) return;
    const now = fields();
    const field = now[Math.min(at, now.length - 1)];
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }

  /** `kenMarkdown.alwaysShowProperties`: an empty panel for documents without any. */
  setAlwaysShow(on: boolean): void {
    if (on === this.alwaysShow) return;
    this.alwaysShow = on;
    // Hiding always applies; showing waits for a field being edited to finish.
    if (!on || !(this.el.contains(document.activeElement) && this.expanded)) this.render();
  }

  /**
   * Expand. Without frontmatter, a blank property to fill in: nothing is
   * written until it has a name.
   */
  open(): void {
    const adding = !this.front;
    if (adding) {
      this.model ??= parseFrontmatter("---\n---\n");
      if (!entries(this.model).some((e) => !e.key)) this.model.segments.push({ entry: { key: "", inline: "", continuation: [] } });
      this.draft = true;
    }
    this.expanded = true;
    this.render();
    this.el.querySelector<HTMLInputElement>(adding ? ".ken-fm-key" : ".ken-fm-value")?.focus();
  }

  /**
   * Set (or with `null`, remove) one one-line property, changing only its
   * line (frontmatterModel.ts `setProperty`); frontmatter is added if there
   * is none.
   */
  setProperty(key: string, value: string | null): void {
    const next = setProperty(this.front, key, value);
    if (next === this.front) return;
    this.commit(next);
    this.render();
  }

  private commit(front: string) {
    this.front = front;
    this.model = front ? parseFrontmatter(front) : null;
    this.onChange(front);
  }

  /** Save the model as edited in place (rows keep editing the same entries). */
  private update() {
    if (!this.model) return;
    // An always-shown panel on a document without frontmatter writes nothing
    // until a property has a name.
    if (!this.front && !entries(this.model).some((e) => e.key)) return;
    this.front = formatFrontmatter(this.model);
    this.onChange(this.front);
  }

  private render() {
    this.el.replaceChildren();
    document.body.classList.toggle("has-frontmatter", !!this.front);
    // A draft ends once written, or when collapsed without a name.
    if (this.draft && (this.front || !this.expanded)) this.draft = false;
    // The placeholder model of an always-shown panel goes with the setting.
    if (!this.front && !this.alwaysShow && !this.draft) this.model = null;
    if (!this.model && this.alwaysShow) {
      // Nothing in the file yet: an empty model the rows can edit; it is
      // only written once a property has a name.
      this.model = parseFrontmatter("---\n---\n");
    }
    this.el.hidden = !this.model;
    if (!this.model) return;
    this.el.classList.toggle("expanded", this.expanded);
    this.shownRaw = this.raw || !!rowsUnsupported(this.model);
    this.el.append(this.header());
    if (this.expanded) this.el.append(this.shownRaw ? this.rawEditor() : this.rows());
  }

  /**
   * The fields/YAML switch: unavailable, saying why, while the frontmatter
   * is something only the YAML view can show.
   */
  private syncYamlButton() {
    const b = this.yamlButton;
    if (!b || !this.model) return;
    const reason = rowsUnsupported(this.model);
    const label = reason ?? (this.shownRaw ? "Edit as fields" : "Edit as YAML");
    b.title = label;
    b.setAttribute("aria-label", label);
    if (reason) b.setAttribute("aria-disabled", "true");
    else b.removeAttribute("aria-disabled");
    b.classList.toggle("active", this.shownRaw);
  }

  private header(): HTMLElement {
    const head = document.createElement("div");
    head.className = "ken-fm-header";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ken-fm-toggle";
    toggle.setAttribute("aria-expanded", String(this.expanded));
    toggle.title = this.expanded ? "Collapse properties" : "Expand to edit properties";
    const chevron = icon(ChevronRight);
    chevron.classList.add("ken-fm-chevron");
    const label = document.createElement("span");
    label.className = "ken-fm-label";
    label.append(icon(Tags, 13), document.createTextNode("Properties"));
    toggle.append(chevron, label);
    if (!this.expanded) toggle.append(this.preview());
    toggle.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.render();
    });
    head.append(toggle);
    if (this.expanded) {
      const yaml = this.smallButton(Braces, "Edit as YAML", () => {
        if (yaml.getAttribute("aria-disabled") === "true") return;
        this.raw = !this.shownRaw;
        this.render();
      });
      yaml.classList.add("ken-fm-yaml");
      this.yamlButton = yaml;
      const remove = this.smallButton(Trash2, "Remove properties", () => {
        this.expanded = false;
        this.raw = false;
        this.commit("");
        this.render();
      });
      remove.classList.add("danger");
      const onNumbering = this.options.onHeadingNumbering;
      if (onNumbering) {
        const gear = this.smallButton(Settings, "Heading numbering…", () => onNumbering());
        gear.classList.add("ken-fm-numbering");
        head.append(gear);
      }
      head.append(yaml, remove);
      this.syncYamlButton();
    } else this.yamlButton = null;
    return head;
  }

  private preview(): HTMLElement {
    const box = document.createElement("span");
    box.className = "ken-fm-preview";
    const list = entries(this.model!);
    if (!list.length) {
      box.textContent = "none";
      return box;
    }
    for (const e of list.slice(0, 6)) {
      const chip = document.createElement("span");
      chip.className = "ken-fm-chip";
      const k = document.createElement("span");
      k.className = "ken-fm-chip-key";
      k.textContent = e.key;
      const v = document.createElement("span");
      v.className = "ken-fm-chip-value";
      const tokens = previewTokens(e);
      if (tokens.some((t) => t.text.trim())) paintTokens(v, tokens);
      else v.textContent = "—";
      chip.append(k, v);
      box.append(chip);
    }
    if (list.length > 6) {
      const more = document.createElement("span");
      more.className = "ken-fm-more";
      more.textContent = `+${list.length - 6}`;
      box.append(more);
    }
    return box;
  }

  private rows(): HTMLElement {
    const box = document.createElement("div");
    box.className = "ken-fm-rows";
    for (const entry of entries(this.model!)) box.append(this.row(entry));
    const add = this.smallButton(Plus, "Add property", () => {
      this.model!.segments.push({ entry: { key: "", inline: "", continuation: [] } });
      this.render();
      const keys = this.el.querySelectorAll<HTMLInputElement>(".ken-fm-key");
      keys[keys.length - 1]?.focus();
    });
    add.classList.add("ken-fm-add");
    add.append(document.createTextNode("Add property"));
    box.append(add);
    return box;
  }

  private row(entry: FrontEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "ken-fm-row";
    const { field: keyField, area: key } = mirroredField("key", entry.key, "key", (text, m) =>
      paintTokens(m, [{ type: "key", text }]),
    );
    key.setAttribute("aria-label", "Property name");
    key.addEventListener("input", () => {
      // A name is one line (a pasted newline goes).
      if (key.value.includes("\n")) key.value = key.value.replace(/\r?\n/g, "");
      entry.key = key.value.replace(/[:\n]/g, "").trim();
      // A row without a name is not written until it has one.
      if (entry.key) this.update();
    });
    const multi = entry.continuation.length > 0;
    const { field: valueField, area: value } = mirroredField("value", valueText(entry), "value", (text, m) =>
      paintTokens(
        m,
        // One line is a value as written after `key:`; more are YAML lines (a block list).
        text.includes("\n")
          ? highlightYaml(text).flatMap((line, i) => (i ? [{ type: null, text: "\n" }, ...line] : line))
          : yamlTokens(text),
      ),
    );
    value.setAttribute("aria-label", `${entry.key || "Property"} value`);
    value.addEventListener("input", () => {
      setValueText(entry, value.value);
      if (entry.key) this.update();
    });
    const remove = this.smallButton(X, `Remove ${entry.key || "property"}`, () => {
      this.model!.segments = this.model!.segments.filter((s) => !("entry" in s && s.entry === entry));
      this.update();
      this.render();
    });
    remove.classList.add("ken-fm-remove");
    // Enter in a key moves to its value; in a single-line value, adds a row.
    key.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        value.focus();
      }
    });
    if (!multi) {
      value.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.el.querySelector<HTMLButtonElement>(".ken-fm-add")?.click();
        }
      });
    }
    row.append(keyField, valueField, remove);
    const warn = () => {
      const message = entry.key ? (this.options.propertyWarning?.(entry.key, valueText(entry)) ?? null) : null;
      row.classList.toggle("warning", !!message);
      row.querySelector(".ken-fm-warning")?.remove();
      if (!message) return;
      const badge = document.createElement("span");
      badge.className = "ken-fm-warning";
      badge.title = message;
      badge.setAttribute("aria-label", message);
      badge.setAttribute("role", "img");
      badge.append(icon(TriangleAlert, 13));
      valueField.append(badge);
    };
    warn();
    key.addEventListener("input", warn);
    value.addEventListener("input", warn);
    return row;
  }

  private rawEditor(): HTMLElement {
    const body = this.front.replace(/^---\r?\n/, "").replace(/\r?\n?---[ \t]*(\r?\n)?$/, "");
    const { field, area } = mirroredField("raw", body, "key: value", (text, m) =>
      highlightYaml(text).forEach((line, i) => {
        if (i) m.append("\n");
        paintTokens(m, line);
      }),
    );
    area.setAttribute("aria-label", "Properties as YAML");
    area.addEventListener("input", () => {
      const eol = this.front.includes("\r\n") ? "\r\n" : "\n";
      const text = area.value.replace(/\r?\n/g, eol).replace(/\s+$/, "");
      this.commit(`---${eol}${text ? text + eol : ""}---${eol}`);
      // The switch follows what was typed; the view itself stays put.
      this.syncYamlButton();
    });
    return field;
  }

  private smallButton(node: IconNode, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ken-fm-button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(icon(node));
    b.addEventListener("click", onClick);
    return b;
  }

  destroy(): void {
    if (instance === this) instance = null;
    this.el.remove();
  }
}
