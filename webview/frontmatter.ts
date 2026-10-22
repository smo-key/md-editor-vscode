/**
 * Frontmatter, shown as a "Properties" panel above the document.
 *
 * Collapsed (the default) it is one quiet line previewing the key-value
 * pairs; expanded, each pair is an editable row (key, value, remove), with
 * rows to add, a raw YAML view for anything the rows do not suit, and a way to
 * remove the properties altogether. Edits change only the lines they touch
 * (see frontmatterModel.ts) and are saved like any other edit.
 */
import { ChevronRight, Plus, Tags, Trash2, X, Braces, createElement, type IconNode } from "lucide";

import {
  entries,
  formatFrontmatter,
  parseFrontmatter,
  previewValue,
  setValueText,
  valueText,
  type FrontEntry,
  type Frontmatter,
} from "./frontmatterModel";

type Change = (front: string) => void;

const icon = (node: IconNode, size = 14) => createElement(node, { width: size, height: size, "stroke-width": 1.75 });

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
  /** Show the panel even when the document has no frontmatter (setting). */
  private alwaysShow = false;

  constructor(
    host: HTMLElement,
    private readonly onChange: Change,
    /** Default title for new frontmatter (the document's file name). */
    private readonly defaultTitle: () => string,
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

  /** `kenMarkdown.alwaysShowProperties`: an empty panel for documents without any. */
  setAlwaysShow(on: boolean): void {
    if (on === this.alwaysShow) return;
    this.alwaysShow = on;
    // Hiding always applies; showing waits for a field being edited to finish.
    if (!on || !(this.el.contains(document.activeElement) && this.expanded)) this.render();
  }

  /** Expand, creating frontmatter first if there is none. */
  open(): void {
    if (!this.model) {
      const title = this.defaultTitle().replace(/"/g, '\\"');
      this.commit(`---\ntitle: ${/[:#[\]{},&*!|>'"%@`]/.test(title) ? `"${title}"` : title}\n---\n`);
    }
    this.expanded = true;
    this.render();
    this.el.querySelector<HTMLInputElement>(".ken-fm-value")?.focus();
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
    // The placeholder model of an always-shown panel goes with the setting.
    if (!this.front && !this.alwaysShow) this.model = null;
    if (!this.model && this.alwaysShow) {
      // Nothing in the file yet: an empty model the rows can edit; it is
      // only written once a property has a name.
      this.model = parseFrontmatter("---\n---\n");
    }
    this.el.hidden = !this.model;
    if (!this.model) return;
    this.el.classList.toggle("expanded", this.expanded);
    this.el.append(this.header());
    if (this.expanded) this.el.append(this.raw ? this.rawEditor() : this.rows());
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
      const yaml = this.smallButton(Braces, this.raw ? "Edit as fields" : "Edit as YAML", () => {
        this.raw = !this.raw;
        this.render();
      });
      yaml.classList.toggle("active", this.raw);
      const remove = this.smallButton(Trash2, "Remove properties", () => {
        this.expanded = false;
        this.raw = false;
        this.commit("");
        this.render();
      });
      remove.classList.add("danger");
      head.append(yaml, remove);
    }
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
      v.textContent = previewValue(e) || "—";
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
    const key = document.createElement("input");
    key.className = "ken-fm-key";
    key.value = entry.key;
    key.placeholder = "key";
    key.spellcheck = false;
    key.setAttribute("aria-label", "Property name");
    key.addEventListener("input", () => {
      entry.key = key.value.replace(/[:\n]/g, "").trim();
      // A row without a name is not written until it has one.
      if (entry.key) this.update();
    });
    const multi = entry.continuation.length > 0;
    const value = document.createElement(multi ? "textarea" : "input") as HTMLInputElement | HTMLTextAreaElement;
    value.className = "ken-fm-value";
    value.value = valueText(entry);
    value.placeholder = "value";
    value.spellcheck = false;
    value.setAttribute("aria-label", `${entry.key || "Property"} value`);
    if (value instanceof HTMLTextAreaElement) value.rows = Math.min(8, entry.continuation.length + 1);
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
        if ((e as KeyboardEvent).key === "Enter") {
          e.preventDefault();
          this.el.querySelector<HTMLButtonElement>(".ken-fm-add")?.click();
        }
      });
    }
    row.append(key, value, remove);
    return row;
  }

  private rawEditor(): HTMLElement {
    const area = document.createElement("textarea");
    area.className = "ken-fm-raw";
    area.spellcheck = false;
    const body = this.front.replace(/^---\r?\n/, "").replace(/\r?\n?---[ \t]*(\r?\n)?$/, "");
    area.value = body;
    area.rows = Math.min(16, Math.max(3, body.split("\n").length + 1));
    area.setAttribute("aria-label", "Properties as YAML");
    area.addEventListener("input", () => {
      const eol = this.front.includes("\r\n") ? "\r\n" : "\n";
      const text = area.value.replace(/\r?\n/g, eol).replace(/\s+$/, "");
      this.commit(`---${eol}${text ? text + eol : ""}---${eol}`);
    });
    return area;
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
