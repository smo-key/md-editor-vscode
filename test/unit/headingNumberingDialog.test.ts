import { afterEach, describe, expect, it, vi } from "vitest";

import { headingNumbersConfig } from "../../src/headingNumbers";
import { FrontmatterPanel } from "../../webview/frontmatter";
import { closeHeadingNumberingDialog, openHeadingNumberingDialog } from "../../webview/headingNumberingDialog";

const settings = headingNumbersConfig({ enabled: false });

const dialog = () => document.querySelector<HTMLElement>(".ken-numbering-dialog")!;
const radio = (mode: string) => dialog().querySelector<HTMLInputElement>(`input[type=radio][value=${mode}]`)!;
const select = (level: number) => dialog().querySelector<HTMLSelectElement>(`select[data-level="${level}"]`)!;
const presetSelect = () => dialog().querySelector<HTMLSelectElement>(".ken-numbering-preset")!;
const parents = (level: number) => dialog().querySelector<HTMLSelectElement>(`select[data-parents="${level}"]`)!;
const prefix = (level: number) => dialog().querySelector<HTMLInputElement>(`input[data-prefix="${level}"]`)!;
const separator = () => dialog().querySelector<HTMLInputElement>(".ken-numbering-separator")!;
const button = (name: string) => [...dialog().querySelectorAll("button")].find((b) => b.textContent === name)!;
const preview = () => dialog().querySelector(".ken-numbering-preview")!.textContent;
const change = (el: HTMLInputElement | HTMLSelectElement, value?: string) => {
  if (value !== undefined) el.value = value;
  if (el instanceof HTMLInputElement && el.type === "radio") el.checked = true;
  el.dispatchEvent(new Event(el instanceof HTMLInputElement && el.type !== "radio" ? "input" : "change", { bubbles: true }));
};

afterEach(() => {
  closeHeadingNumberingDialog();
  document.body.replaceChildren();
});

describe("heading numbering dialog", () => {
  it("starts from the document's property", () => {
    openHeadingNumberingDialog({ settings, property: '"I-1"', onApply: () => undefined });
    expect(dialog().getAttribute("role")).toBe("dialog");
    expect(radio("on").checked).toBe(true);
    expect(select(1).value).toBe("upper-roman");
    expect(select(2).value).toBe("decimal");
    expect(select(3).value).toBe("lower-roman");
    expect(separator().value).toBe("-");
    expect(preview()).toBe("I · I-1 · I-1-i · I-1-i-1 · I-1-i-1-a · I-1-i-1-a-i");
  });

  it("uses the editor settings without the property, styles shown but locked", () => {
    openHeadingNumberingDialog({ settings, property: undefined, onApply: () => undefined });
    expect(radio("settings").checked).toBe(true);
    expect(select(1).disabled).toBe(true);
    expect(presetSelect().disabled).toBe(true);
    expect(presetSelect().value).toBe("outline");
  });

  it("has no description line and no Remove button: just Cancel and Apply", () => {
    openHeadingNumberingDialog({ settings, property: "off", onApply: () => undefined });
    expect(dialog().textContent).not.toContain("For this document only");
    expect(dialog().querySelector("h2")!.title).toContain("ken-heading-numbering");
    expect([...dialog().querySelectorAll("footer button")].map((b) => b.textContent)).toEqual(["Cancel", "Apply"]);
  });

  it("fills the fields from a preset, and shows Custom once one is edited", () => {
    const onApply = vi.fn();
    openHeadingNumberingDialog({ settings, property: undefined, onApply });
    change(radio("on"));
    change(presetSelect(), "legal-article");
    expect(select(1).value).toBe("upper-roman");
    expect(prefix(1).value).toBe("Article ");
    expect(select(2).value).toBe("decimal-leading-zero");
    expect(parents(2).value).toBe("legal");
    expect(select(3).value).toBe("parenthesized-lower-alpha");
    expect(preview()).toBe("Article I · Section 1.01 · (a) · (i) · (A) · (1)");
    button("Apply").click();
    expect(onApply).toHaveBeenLastCalledWith("legal-article");

    openHeadingNumberingDialog({ settings, property: "legal-article", onApply });
    expect(presetSelect().value).toBe("legal-article");
    change(prefix(1), "ARTICLE ");
    expect(presetSelect().value).toBe("custom");
    change(parents(3), "full");
    expect(preview()).toBe("ARTICLE I · Section 1.01 · I.01(a) · (i) · (A) · (1)");
    button("Apply").click();
    expect(onApply).toHaveBeenLastCalledWith('"[ARTICLE ]I.[Section ]01#.(a)+.(i).(A).(1)"');

    openHeadingNumberingDialog({ settings, property: '"[ARTICLE ]I.[Section ]01#.(a)+.(i).(A).(1)"', onApply });
    expect(presetSelect().value).toBe("custom");
    expect(prefix(1).value).toBe("ARTICLE ");
    expect(parents(3).value).toBe("full");
  });

  it("refuses a prefix the format can't hold", () => {
    openHeadingNumberingDialog({ settings, property: "on", onApply: () => undefined });
    change(prefix(1), "a]");
    expect(button("Apply").disabled).toBe(true);
  });

  it("flags an invalid property", () => {
    openHeadingNumberingDialog({ settings, property: "bogus", onApply: () => undefined });
    expect(radio("settings").checked).toBe(true);
    expect(dialog().querySelector(".ken-numbering-warning")?.textContent).toContain("bogus");
  });

  it("applies the compact form", () => {
    const onApply = vi.fn();
    openHeadingNumberingDialog({ settings, property: undefined, onApply });
    change(radio("on"));
    expect(select(1).disabled).toBe(false);
    button("Apply").click();
    expect(onApply).toHaveBeenLastCalledWith("on");
    expect(dialog()).toBeNull();

    openHeadingNumberingDialog({ settings, property: undefined, onApply });
    change(radio("on"));
    change(select(2), "upper-alpha");
    change(separator(), "/");
    expect(preview()).toBe("1 · 1/A · 1/A/i · 1/A/i/1 · 1/A/i/1/a · 1/A/i/1/a/i");
    button("Apply").click();
    expect(onApply).toHaveBeenLastCalledWith('"1/A/i/1/a/i"');

    openHeadingNumberingDialog({ settings, property: "on", onApply });
    change(radio("off"));
    expect(preview()).toBe("Off");
    button("Apply").click();
    expect(onApply).toHaveBeenLastCalledWith("off");

    openHeadingNumberingDialog({ settings, property: "on", onApply });
    change(radio("settings"));
    button("Apply").click();
    expect(onApply).toHaveBeenLastCalledWith(null);
  });


  it("refuses a separator the format can't hold", () => {
    const onApply = vi.fn();
    openHeadingNumberingDialog({ settings, property: "on", onApply });
    change(separator(), "a");
    expect(button("Apply").disabled).toBe(true);
    expect(dialog().querySelector(".ken-numbering-error")?.textContent).toMatch(/can't contain/);
  });

  it("cancels on Escape and Cancel, writing nothing", () => {
    const onApply = vi.fn();
    openHeadingNumberingDialog({ settings, property: "on", onApply });
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
    openHeadingNumberingDialog({ settings, property: "on", onApply });
    button("Cancel").click();
    expect(dialog()).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog", () => {
    openHeadingNumberingDialog({ settings, property: "on", onApply: () => undefined });
    const focusable = [...dialog().querySelectorAll<HTMLElement>("button, input, select")].filter((el) => !(el as HTMLButtonElement).disabled);
    focusable[focusable.length - 1]!.focus();
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(focusable[0]);
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });
});

describe("Properties panel and the dialog", () => {
  const FRONT = ["---", "title:    Spaced  ", "tags :", "  - a", "# note", "date: 2024-01-01", "---", ""].join("\n");

  function panel(front: string, onHeadingNumbering = vi.fn()) {
    const host = document.createElement("div");
    document.body.append(host);
    const changes: string[] = [];
    const p = new FrontmatterPanel(host, (next) => changes.push(next), {
      onHeadingNumbering,
      propertyWarning: (key, value) => (key === "ken-heading-numbering" && value === "bogus" ? "Not valid" : null),
    });
    p.set(front);
    return { p, host, changes, onHeadingNumbering };
  }

  it("has a gear in the expanded header that opens the dialog", () => {
    const { host, onHeadingNumbering } = panel(FRONT);
    expect(host.querySelector('[aria-label="Heading numbering…"]')).toBeNull();
    host.querySelector<HTMLButtonElement>(".ken-fm-toggle")!.click();
    const gear = host.querySelector<HTMLButtonElement>('[aria-label="Heading numbering…"]')!;
    expect(gear.title).toBe("Heading numbering…");
    gear.click();
    expect(onHeadingNumbering).toHaveBeenCalled();
  });

  it("writes exactly one frontmatter line through the dialog", () => {
    const { p, changes } = panel(FRONT);
    openHeadingNumberingDialog({ settings, property: undefined, onApply: (v) => p.setProperty("ken-heading-numbering", v) });
    change(radio("off"));
    button("Apply").click();
    expect(changes).toHaveLength(1);
    const before = FRONT.split("\n");
    const after = changes[0]!.split("\n");
    expect(after.filter((l) => !before.includes(l))).toEqual(["ken-heading-numbering: off"]);
    expect(after.filter((l) => l !== "ken-heading-numbering: off")).toEqual(before);
  });

  it("removes the property line, and a block it leaves empty, with Use editor settings", () => {
    const { p, changes } = panel(["---", "title:    Spaced  ", "ken-heading-numbering: legal", "date: 2024-01-01", "---", ""].join("\n"));
    openHeadingNumberingDialog({ settings, property: "legal", onApply: (v) => p.setProperty("ken-heading-numbering", v) });
    change(radio("settings"));
    button("Apply").click();
    expect(changes).toEqual([["---", "title:    Spaced  ", "date: 2024-01-01", "---", ""].join("\n")]);

    const only = panel("---\nken-heading-numbering: off\n---\n");
    openHeadingNumberingDialog({ settings, property: "off", onApply: (v) => only.p.setProperty("ken-heading-numbering", v) });
    change(radio("settings"));
    button("Apply").click();
    expect(only.changes).toEqual([""]);
  });

  it("shows the property as a flat row, flagging an invalid value", () => {
    const { host } = panel("---\ntitle: x\nken-heading-numbering: bogus\n---\n");
    host.querySelector<HTMLButtonElement>(".ken-fm-toggle")!.click();
    expect(host.querySelectorAll(".ken-fm-row")).toHaveLength(2);
    expect(host.querySelector(".ken-fm-raw")).toBeNull();
    const flagged = host.querySelector<HTMLElement>(".ken-fm-row.warning")!;
    expect(flagged.querySelector<HTMLTextAreaElement>(".ken-fm-key")!.value).toBe("ken-heading-numbering");
    expect(flagged.querySelector(".ken-fm-warning")?.getAttribute("title")).toBe("Not valid");
  });
});
