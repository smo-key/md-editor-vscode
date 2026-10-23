import { describe, expect, it } from "vitest";
import { FrontmatterPanel } from "../../webview/frontmatter";
import {
  entries,
  highlightYaml,
  formatFrontmatter,
  parseFrontmatter,
  previewValue,
  rowsUnsupported,
  setValueText,
  splitFrontmatter,
  valueText,
  yamlTokens,
} from "../../webview/frontmatterModel";

const FRONT = "---\ntitle: Sample\naliases: [demo]\ntags:\n  - one\n  - two\n# a comment\n\nurl: https://x.dev/a:b\n---\n";

describe("frontmatter model", () => {
  it("finds the block at the start of a document only", () => {
    expect(splitFrontmatter(`${FRONT}# Doc\n`)).toBe(FRONT);
    expect(splitFrontmatter("# Doc\n\n---\nx: 1\n---\n")).toBe("");
    expect(splitFrontmatter("---\n---\nBody\n")).toBe("---\n---\n");
  });

  it("round-trips untouched, comments and blank lines included", () => {
    expect(formatFrontmatter(parseFrontmatter(FRONT))).toBe(FRONT);
    const crlf = FRONT.replace(/\n/g, "\r\n");
    expect(formatFrontmatter(parseFrontmatter(crlf))).toBe(crlf);
  });

  it("reads entries with inline and block values", () => {
    const list = entries(parseFrontmatter(FRONT));
    expect(list.map((e) => e.key)).toEqual(["title", "aliases", "tags", "url"]);
    expect(valueText(list[2]!)).toBe("  - one\n  - two");
    expect(previewValue(list[2]!)).toBe("one, two");
    expect(list[3]!.inline).toBe("https://x.dev/a:b");
  });

  it("edits only the lines of the entry that changed", () => {
    const fm = parseFrontmatter(FRONT);
    setValueText(entries(fm)[0]!, "New title");
    expect(formatFrontmatter(fm)).toBe(FRONT.replace("title: Sample", "title: New title"));
    setValueText(entries(fm)[1]!, "- a\n- b");
    expect(formatFrontmatter(fm)).toContain("aliases:\n- a\n- b\ntags:");
  });

  it("does not write a row that has no name yet", () => {
    const fm = parseFrontmatter(FRONT);
    fm.segments.push({ entry: { key: "", inline: "draft", continuation: [] } });
    expect(formatFrontmatter(fm)).toBe(FRONT);
  });
});

const kinds = (text: string) => yamlTokens(text).filter((t) => t.type).map((t) => [t.type, t.text]);

describe("YAML value tokens", () => {
  it("tells scalar types apart", () => {
    expect(kinds("true")).toEqual([["bool", "true"]]);
    expect(kinds("False")).toEqual([["bool", "False"]]);
    expect(kinds("42")).toEqual([["number", "42"]]);
    expect(kinds("-3.5e2")).toEqual([["number", "-3.5e2"]]);
    expect(kinds("0x1F")).toEqual([["number", "0x1F"]]);
    expect(kinds("~")).toEqual([["null", "~"]]);
    expect(kinds("null")).toEqual([["null", "null"]]);
    expect(kinds("2024-01-31")).toEqual([["date", "2024-01-31"]]);
    expect(kinds("2024-01-31T10:00:00Z")).toEqual([["date", "2024-01-31T10:00:00Z"]]);
    expect(kinds('"quoted: yes"')).toEqual([["string", '"quoted: yes"']]);
    expect(kinds("'single'")).toEqual([["string", "'single'"]]);
    expect(kinds("Hello world")).toEqual([["plain", "Hello world"]]);
    expect(kinds("https://x.dev/a:b")).toEqual([["plain", "https://x.dev/a:b"]]);
  });

  it("splits flow collections into punctuation and items", () => {
    expect(kinds("[a, 1, true]")).toEqual([
      ["punct", "["], ["plain", "a"], ["punct", ","], ["number", "1"], ["punct", ","], ["bool", "true"], ["punct", "]"],
    ]);
    expect(kinds("{a: 1}")).toEqual([["punct", "{"], ["key", "a"], ["punct", ":"], ["number", "1"], ["punct", "}"]]);
  });

  it("marks comments, anchors and aliases", () => {
    expect(kinds("x # note")).toEqual([["plain", "x"], ["comment", "# note"]]);
    expect(kinds("&base x")).toEqual([["anchor", "&base"], ["plain", "x"]]);
    expect(kinds("*base")).toEqual([["anchor", "*base"]]);
  });

  it("keeps the text exactly", () => {
    for (const s of ["[a,  'b c' , {d: e}]", '"a \\" b" # c', "plain  text", ""]) {
      expect(yamlTokens(s).map((t) => t.text).join("")).toBe(s);
    }
  });

  it("highlights whole YAML lines for the raw view", () => {
    const lines = highlightYaml("title: Hi\ntags:\n  - one\n# c\nbody: |\n  some: text\n  more\nn: 1");
    const flat = lines.map((l) => l.filter((t) => t.type).map((t) => `${t.type}:${t.text}`));
    expect(flat[0]).toEqual(["key:title", "punct::", "plain:Hi"]);
    expect(flat[2]).toEqual(["punct:-", "plain:one"]);
    expect(flat[3]).toEqual(["comment:# c"]);
    expect(flat[4]).toEqual(["key:body", "punct::", "punct:|"]);
    // Inside a block scalar everything is text, even what looks like a key.
    expect(flat[5]).toEqual(["string:  some: text"]);
    expect(flat[6]).toEqual(["string:  more"]);
    expect(flat[7]).toEqual(["key:n", "punct::", "number:1"]);
  });
});

describe("what the rows can edit", () => {
  const reason = (body: string) => rowsUnsupported(parseFrontmatter(`---\n${body}\n---\n`));

  it("accepts flat scalars, flow collections, block lists of scalars and top-level comments", () => {
    expect(reason("title: Sample\nn: 3\ndraft: false\naliases: [a, b]\nmeta: {a: 1}\ntags:\n  - one\n  - two\n# note\n\nempty:")).toBeNull();
    expect(rowsUnsupported(parseFrontmatter(FRONT))).toBeNull();
  });

  it("rejects what a row would show or save wrongly", () => {
    expect(reason("author:\n  name: Ann\n  url: x")).toMatch(/Nested/);
    expect(reason("people:\n  - name: Ann\n  - name: Bo")).toMatch(/Nested/);
    expect(reason("list:\n  - - a")).toMatch(/Nested/);
    expect(reason("body: |\n  line one\n  line two")).toMatch(/Multi-line/);
    expect(reason("body: >-\n  folded")).toMatch(/Multi-line/);
    expect(reason("title: a long\n  plain continued")).toMatch(/Multi-line/);
    expect(reason("base: &b x\nother: *b")).toMatch(/Anchors/);
    expect(reason("when: !!str 2024")).toMatch(/tags/i);
    expect(reason("title: x # why")).toMatch(/Comments/);
    expect(reason("tags:\n  # first\n  - one")).toMatch(/Comments/);
    expect(reason("? complex\n: key")).toMatch(/YAML/);
  });

  it("ignores a draft row that has no name yet", () => {
    const fm = parseFrontmatter("---\na: 1\n---\n");
    fm.segments.push({ entry: { key: "", inline: "", continuation: [] } });
    expect(rowsUnsupported(fm)).toBeNull();
  });
});

describe("properties panel", () => {
  function mount(front: string) {
    const host = document.createElement("div");
    document.body.append(host);
    const changes: string[] = [];
    const panel = new FrontmatterPanel(host, (f) => changes.push(f));
    panel.set(front);
    const expand = () => (panel.el.querySelector(".ken-fm-toggle") as HTMLButtonElement).click();
    const yamlButton = () => panel.el.querySelector<HTMLButtonElement>(".ken-fm-yaml")!;
    return { panel, changes, expand, yamlButton, done: () => { panel.destroy(); host.remove(); } };
  }

  it("colors the collapsed preview by type and keeps every key whole", () => {
    const longKey = "a_really_long_property_name_that_never_gets_cut";
    const { panel, done } = mount(`---\ntitle: "Hi"\nn: 3\nok: true\n${longKey}: ${"word ".repeat(40).trim()}\n---\n`);
    const chips = [...panel.el.querySelectorAll(".ken-fm-chip")];
    expect(chips.map((c) => c.querySelector(".ken-fm-chip-key")!.textContent)).toEqual(["title", "n", "ok", longKey]);
    expect(chips[0]!.querySelector(".ken-yaml-string")?.textContent).toBe('"Hi"');
    expect(chips[1]!.querySelector(".ken-yaml-number")?.textContent).toBe("3");
    expect(chips[2]!.querySelector(".ken-yaml-bool")?.textContent).toBe("true");
    // The whole value is there to wrap, not an ellipsized slice.
    expect(chips[3]!.querySelector(".ken-fm-chip-value")!.textContent).toBe("word ".repeat(40).trim());
    done();
  });

  it("colors row values and wraps them in a growing field", () => {
    const { panel, expand, done } = mount("---\ntitle: Hi\ncount: 3\ntags: [a, b]\n---\n");
    expand();
    const rows = [...panel.el.querySelectorAll(".ken-fm-row")];
    expect(rows).toHaveLength(3);
    const value = rows[1]!.querySelector<HTMLTextAreaElement>("textarea.ken-fm-value")!;
    expect(value.value).toBe("3");
    expect(rows[1]!.querySelector(".ken-fm-value-field .ken-yaml-number")?.textContent).toBe("3");
    expect(rows[0]!.querySelector(".ken-fm-key-field .ken-yaml-key")?.textContent).toBe("title");
    // Typing re-colors the mirror the field grows with.
    value.value = "true";
    value.dispatchEvent(new Event("input"));
    expect(rows[1]!.querySelector(".ken-fm-value-field .ken-yaml-bool")?.textContent).toBe("true");
    done();
  });

  it("raw view grows with its content instead of scrolling", () => {
    const { panel, expand, yamlButton, changes, done } = mount("---\ntitle: Hi\n---\n");
    expand();
    yamlButton().click();
    const area = panel.el.querySelector<HTMLTextAreaElement>("textarea.ken-fm-raw")!;
    expect(area).toBeTruthy();
    expect(area.closest(".ken-fm-raw-field")).toBeTruthy();
    const mirror = () => panel.el.querySelector(".ken-fm-raw-field .ken-fm-mirror")!;
    expect(mirror().querySelector(".ken-yaml-key")?.textContent).toBe("title");
    area.value = "title: Hi\na: 1\nb: 2\nc: 3";
    area.dispatchEvent(new Event("input"));
    expect(mirror().textContent).toContain("c: 3");
    expect(changes.at(-1)).toBe("---\ntitle: Hi\na: 1\nb: 2\nc: 3\n---\n");
    done();
  });

  it("shows only YAML for frontmatter the rows cannot represent", () => {
    const { panel, expand, yamlButton, done } = mount("---\nauthor:\n  name: Ann\n---\n");
    expand();
    expect(panel.el.querySelector(".ken-fm-rows")).toBeNull();
    const area = panel.el.querySelector<HTMLTextAreaElement>("textarea.ken-fm-raw")!;
    expect(area.value).toBe("author:\n  name: Ann");
    const button = yamlButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.title).toMatch(/Nested properties can only be edited as YAML/);
    button.click();
    expect(panel.el.querySelector("textarea.ken-fm-raw")).toBeTruthy();
    // Flattened while typing: the toggle comes back (the view stays put).
    area.value = "author: Ann";
    area.dispatchEvent(new Event("input"));
    expect(button.getAttribute("aria-disabled")).toBeNull();
    button.click();
    expect(panel.el.querySelector(".ken-fm-rows")).toBeTruthy();
    done();
  });

  it("re-evaluates when the document changes outside", () => {
    const { panel, expand, yamlButton, done } = mount("---\ntitle: Hi\n---\n");
    expand();
    expect(panel.el.querySelector(".ken-fm-rows")).toBeTruthy();
    panel.set("---\nbody: |\n  text\n---\n");
    expect(panel.el.querySelector(".ken-fm-rows")).toBeNull();
    expect(yamlButton().title).toMatch(/Multi-line/);
    panel.set("---\ntitle: Hi\n---\n");
    expect(panel.el.querySelector(".ken-fm-rows")).toBeTruthy();
    expect(yamlButton().getAttribute("aria-disabled")).toBeNull();
    done();
  });
});
