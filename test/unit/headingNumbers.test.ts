import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEADING_NUMBER_SEPARATOR,
  DEFAULT_HEADING_NUMBER_STYLES,
  effectiveHeadingNumbers,
  formatNumberingProperty,
  HEADING_NUMBER_PARENTS,
  HEADING_NUMBER_PRESET_NAMES,
  HEADING_NUMBER_STYLES,
  numberingChoice,
  prefixProblem,
  presetLevels,
  presetOf,
  sameLevels,
  type HeadingNumberPreset,
  type NumberingLevels,
  parseNumberingProperty,
  separatorProblem,
  type NumberingChoice,
  formatCounter,
  headingNumberLabels,
  headingNumbersConfig,
  type HeadingNumbersConfig,
  type HeadingNumberStyle,
} from "../../src/headingNumbers";

const on = (styles: HeadingNumberStyle[] = [...DEFAULT_HEADING_NUMBER_STYLES], separator = "."): HeadingNumbersConfig =>
  headingNumbersConfig({ enabled: true, styles, separator });

describe("formatCounter", () => {
  it("writes decimal", () => {
    expect(formatCounter(1, "decimal")).toBe("1");
    expect(formatCounter(42, "decimal")).toBe("42");
  });

  it("writes letters, continuing past z as aa, ab…", () => {
    expect(formatCounter(1, "lower-alpha")).toBe("a");
    expect(formatCounter(26, "lower-alpha")).toBe("z");
    expect(formatCounter(27, "lower-alpha")).toBe("aa");
    expect(formatCounter(28, "lower-alpha")).toBe("ab");
    expect(formatCounter(52, "lower-alpha")).toBe("az");
    expect(formatCounter(53, "lower-alpha")).toBe("ba");
    expect(formatCounter(702, "lower-alpha")).toBe("zz");
    expect(formatCounter(703, "lower-alpha")).toBe("aaa");
    expect(formatCounter(3, "upper-alpha")).toBe("C");
    expect(formatCounter(27, "upper-alpha")).toBe("AA");
  });

  it("writes roman numerals", () => {
    expect(formatCounter(1, "lower-roman")).toBe("i");
    expect(formatCounter(4, "lower-roman")).toBe("iv");
    expect(formatCounter(9, "lower-roman")).toBe("ix");
    expect(formatCounter(14, "lower-roman")).toBe("xiv");
    expect(formatCounter(40, "upper-roman")).toBe("XL");
    expect(formatCounter(1994, "upper-roman")).toBe("MCMXCIV");
    expect(formatCounter(3999, "upper-roman")).toBe("MMMCMXCIX");
  });

  it("falls back to decimal past 3999, as CSS's roman counters do", () => {
    expect(formatCounter(4000, "upper-roman")).toBe("4000");
    expect(formatCounter(12345, "lower-roman")).toBe("12345");
  });

  it("writes nothing for none", () => {
    expect(formatCounter(3, "none")).toBe("");
  });
});

describe("headingNumberLabels", () => {
  it("numbers nothing when disabled", () => {
    expect(headingNumberLabels([1, 2, 3], { ...on(), enabled: false })).toEqual([null, null, null]);
  });

  it("numbers each level with its default style", () => {
    expect(headingNumberLabels([1, 2, 3, 4, 5, 6], on())).toEqual([
      "1",
      "1.a",
      "1.a.i",
      "1.a.i.1",
      "1.a.i.1.a",
      "1.a.i.1.a.i",
    ]);
  });

  it("increments a level and resets every deeper one", () => {
    expect(headingNumberLabels([1, 2, 2, 3, 2, 3, 1, 2], on())).toEqual([
      "1",
      "1.a",
      "1.b",
      "1.b.i",
      "1.c",
      "1.c.i",
      "2",
      "2.a",
    ]);
  });

  it("omits a skipped level instead of showing 0", () => {
    expect(headingNumberLabels([1, 2, 4, 4, 3, 4], on())).toEqual([
      "1",
      "1.a",
      "1.a.1",
      "1.a.2",
      "1.a.i",
      "1.a.i.1",
    ]);
  });

  it("starts at a document's shallowest heading when it is not an h1", () => {
    expect(headingNumberLabels([2, 3, 2], on())).toEqual(["a", "a.i", "b"]);
  });

  it("skips a level set to none, in its own label and its descendants'", () => {
    const styles: HeadingNumberStyle[] = ["none", "decimal", "decimal", "decimal", "decimal", "decimal"];
    expect(headingNumberLabels([1, 2, 3, 2], on(styles))).toEqual([null, "1", "1.1", "2"]);
  });

  it("restarts deeper counters under a heading whose level is none", () => {
    const styles: HeadingNumberStyle[] = ["none", "decimal", "decimal", "decimal", "decimal", "decimal"];
    expect(headingNumberLabels([1, 2, 2, 1, 2], on(styles))).toEqual([null, "1", "2", null, "1"]);
  });

  it("drops a middle level set to none", () => {
    const styles: HeadingNumberStyle[] = ["decimal", "none", "decimal", "decimal", "decimal", "decimal"];
    expect(headingNumberLabels([1, 2, 3, 3, 2, 3], on(styles))).toEqual(["1", null, "1.1", "1.2", null, "1.1"]);
  });

  it("joins with the separator", () => {
    expect(headingNumberLabels([1, 2, 3], on(undefined, "-"))).toEqual(["1", "1-a", "1-a-i"]);
    expect(headingNumberLabels([1, 2], on(undefined, ""))).toEqual(["1", "1a"]);
  });

  it("continues past z", () => {
    const levels = [1, ...Array.from({ length: 28 }, () => 2)];
    const labels = headingNumberLabels(levels, on());
    expect(labels[26]).toBe("1.z");
    expect(labels[27]).toBe("1.aa");
    expect(labels[28]).toBe("1.ab");
  });

  it("treats out-of-range levels as the nearest real one", () => {
    expect(headingNumberLabels([0, 7], on())).toEqual(["1", "1.i"]);
  });
});

describe("headingNumbersConfig", () => {
  it("defaults to off with the default styles", () => {
    expect(headingNumbersConfig(undefined)).toEqual({
      enabled: false,
      styles: ["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman"],
      parents: ["auto", "auto", "auto", "auto", "auto", "auto"],
      prefixes: ["", "", "", "", "", ""],
      separator: ".",
    });
  });

  it("keeps valid values and replaces invalid ones with the defaults", () => {
    expect(
      headingNumbersConfig({
        enabled: true,
        styles: ["upper-roman", "bogus", 3, "none"],
        separator: ")",
      }),
    ).toEqual({
      enabled: true,
      styles: ["upper-roman", "lower-alpha", "lower-roman", "none", "lower-alpha", "lower-roman"],
      parents: ["auto", "auto", "auto", "auto", "auto", "auto"],
      prefixes: ["", "", "", "", "", ""],
      separator: ")",
    });
  });

  it("only enables on a real true", () => {
    expect(headingNumbersConfig({ enabled: "yes" }).enabled).toBe(false);
  });

  it("falls back to the default separator when it is not a string", () => {
    expect(headingNumbersConfig({ separator: 3 }).separator).toBe(".");
  });
});

describe("kenMarkdown.headingNumbers settings", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
  };
  const props = pkg.contributes.configuration.properties;

  it("is off by default with a '.' separator", () => {
    expect(props["kenMarkdown.headingNumbers.enabled"]).toMatchObject({ type: "boolean", default: false });
    expect(props["kenMarkdown.headingNumbers.separator"]).toMatchObject({ type: "string", default: DEFAULT_HEADING_NUMBER_SEPARATOR });
  });

  it("offers every style for each level, defaulting as the code does", () => {
    for (let i = 0; i < 6; i++) {
      const setting = props[`kenMarkdown.headingNumbers.h${i + 1}`]!;
      expect(setting.enum).toEqual([...HEADING_NUMBER_STYLES]);
      expect((setting.enumDescriptions as string[]).length).toBe(HEADING_NUMBER_STYLES.length);
      expect(setting.default).toBe(DEFAULT_HEADING_NUMBER_STYLES[i]);
      expect(props[`kenMarkdown.headingNumbers.h${i + 1}Parents`]).toMatchObject({ enum: [...HEADING_NUMBER_PARENTS], default: "auto" });
      expect(props[`kenMarkdown.headingNumbers.h${i + 1}Prefix`]).toMatchObject({ type: "string", default: "" });
    }
  });

  it("offers every preset, custom by default", () => {
    expect(props["kenMarkdown.headingNumbers.preset"]).toMatchObject({ enum: ["custom", ...HEADING_NUMBER_PRESET_NAMES], default: "custom" });
  });
});

describe("ken-heading-numbering property", () => {
  const settings = headingNumbersConfig({ enabled: false });
  const custom = (styles: HeadingNumberStyle[], separator = "."): NumberingChoice => ({
    mode: "on",
    styles,
    parents: ["auto", "auto", "auto", "auto", "auto", "auto"],
    prefixes: ["", "", "", "", "", ""],
    separator,
  });

  it("parses on and off, plain or quoted, in any case", () => {
    for (const raw of ["off", "false", "OFF", "False", '"off"', "'off'"]) expect(parseNumberingProperty(raw)).toMatchObject({ enabled: false });
    for (const raw of ["on", "true", "On", "TRUE", '"on"']) expect(parseNumberingProperty(raw)).toMatchObject({ enabled: true, styles: [] });
  });

  it("parses a format string: one style token per level, H1 first", () => {
    expect(parseNumberingProperty('"1.a.i.1.a.i"')).toMatchObject({
      enabled: true,
      styles: ["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman"],
      separator: ".",
    });
    expect(parseNumberingProperty("1-A-i")).toMatchObject({ enabled: true, styles: ["decimal", "upper-alpha", "lower-roman"], separator: "-" });
    expect(parseNumberingProperty("'I / 1'")).toMatchObject({ enabled: true, styles: ["upper-roman", "decimal"], separator: " / " });
    expect(parseNumberingProperty('"_.1.a"')).toMatchObject({ enabled: true, styles: ["none", "decimal", "lower-alpha"], separator: "." });
    expect(parseNumberingProperty('"1ai"')).toMatchObject({ enabled: true, styles: ["decimal", "lower-alpha", "lower-roman"], separator: "" });
  });

  it("takes the separator from the settings for a single level", () => {
    expect(parseNumberingProperty("I")).toMatchObject({ enabled: true, styles: ["upper-roman"] });
    expect(parseNumberingProperty("I")).not.toHaveProperty("separator");
    expect(parseNumberingProperty("1")).toMatchObject({ enabled: true, styles: ["decimal"] });
  });

  it("unescapes quoted strings", () => {
    expect(parseNumberingProperty('"1\\"a"')).toMatchObject({ enabled: true, styles: ["decimal", "lower-alpha"], separator: '"' });
    expect(parseNumberingProperty("'1''a'")).toMatchObject({ enabled: true, styles: ["decimal", "lower-alpha"], separator: "'" });
  });

  it("rejects anything else", () => {
    for (const raw of ["maybe", "1.a.i.1.a.i.1", "1.a-i", "1..", ".1", '"1.a', "[1, a]", "1.b", "x"]) {
      expect(parseNumberingProperty(raw), raw).toBeNull();
    }
  });

  it("treats an empty or null value as absent", () => {
    expect(parseNumberingProperty("")).toBeUndefined();
    expect(parseNumberingProperty("~")).toBeUndefined();
    expect(parseNumberingProperty("null")).toBeUndefined();
  });

  describe("effective config", () => {
    const on = headingNumbersConfig({ enabled: true, styles: ["upper-roman"], separator: "-" });

    it("is the settings without the property", () => {
      expect(effectiveHeadingNumbers(on, undefined)).toEqual({ config: on, invalid: false });
    });

    it("turns numbering off or on over the settings", () => {
      expect(effectiveHeadingNumbers(on, "off").config.enabled).toBe(false);
      expect(effectiveHeadingNumbers(settings, "on")).toEqual({ config: { ...settings, enabled: true }, invalid: false });
    });

    it("overrides the given levels and the separator, the rest from the settings", () => {
      expect(effectiveHeadingNumbers(on, '"1.a"').config).toMatchObject({
        enabled: true,
        styles: ["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman"],
        separator: ".",
      });
      expect(effectiveHeadingNumbers(on, "A").config).toEqual({ ...on, styles: ["upper-alpha", ...on.styles.slice(1)] });
    });

    it("ignores an invalid value, and says so", () => {
      expect(effectiveHeadingNumbers(on, "bogus")).toEqual({ config: on, invalid: true });
    });
  });

  describe("dialog choice", () => {
    it("reads the property as a choice", () => {
      expect(numberingChoice(undefined, settings)).toEqual({ choice: { mode: "settings" }, invalid: false });
      expect(numberingChoice("bogus", settings)).toEqual({ choice: { mode: "settings" }, invalid: true });
      expect(numberingChoice("off", settings).choice).toEqual({ mode: "off" });
      expect(numberingChoice("on", settings).choice).toEqual(custom([...DEFAULT_HEADING_NUMBER_STYLES]));
      expect(numberingChoice('"I-1"', settings).choice).toEqual(
        custom(["upper-roman", "decimal", "lower-roman", "decimal", "lower-alpha", "lower-roman"], "-"),
      );
    });

    it("writes the compact form", () => {
      expect(formatNumberingProperty({ mode: "settings" }, settings)).toBeNull();
      expect(formatNumberingProperty({ mode: "off" }, settings)).toBe("off");
      expect(formatNumberingProperty(custom([...DEFAULT_HEADING_NUMBER_STYLES]), settings)).toBe("on");
      expect(formatNumberingProperty(custom(["upper-roman", "decimal", "lower-roman", "decimal", "lower-alpha", "none"], "-"), settings)).toBe(
        '"I-1-i-1-a-_"',
      );
      expect(formatNumberingProperty(custom([...DEFAULT_HEADING_NUMBER_STYLES], '"'), settings)).toBe('"1\\"a\\"i\\"1\\"a\\"i"');
    });

    it("round-trips every choice through the property", () => {
      const choices: NumberingChoice[] = [
        { mode: "settings" },
        { mode: "off" },
        custom([...DEFAULT_HEADING_NUMBER_STYLES]),
        custom(["none", "decimal", "upper-alpha", "upper-roman", "lower-roman", "lower-alpha"], " / "),
        custom(["decimal", "decimal", "decimal", "decimal", "decimal", "decimal"], ""),
        custom([...DEFAULT_HEADING_NUMBER_STYLES], "\\"),
        custom(["lower-alpha", ...DEFAULT_HEADING_NUMBER_STYLES.slice(1)], "/"),
      ];
      for (const choice of choices) {
        const raw = formatNumberingProperty(choice, settings);
        expect(numberingChoice(raw ?? undefined, settings), JSON.stringify(choice)).toEqual({ choice, invalid: false });
      }
    });

    it("rejects separators the format string can't hold", () => {
      expect(separatorProblem(".")).toBeNull();
      expect(separatorProblem("")).toBeNull();
      expect(separatorProblem("a")).toMatch(/can't contain/);
      expect(separatorProblem("-1-")).toMatch(/can't contain/);
      expect(separatorProblem("x\ny")).toMatch(/line/);
    });
  });
});

describe("legal numbering", () => {
  // H1 H2 H2 H3 H4 H5 H6 H4 H2 H1 H2
  const OUTLINE = [1, 2, 2, 3, 4, 5, 6, 4, 2, 1, 2];
  const labels = (preset: HeadingNumberPreset) => headingNumberLabels(OUTLINE, headingNumbersConfig({ enabled: true, preset }));

  it("numbers the sample outline with each preset", () => {
    expect(labels("outline")).toEqual(["1", "1.a", "1.b", "1.b.i", "1.b.i.1", "1.b.i.1.a", "1.b.i.1.a.i", "1.b.i.2", "1.c", "2", "2.a"]);
    expect(labels("decimal")).toEqual(["1", "1.1", "1.2", "1.2.1", "1.2.1.1", "1.2.1.1.1", "1.2.1.1.1.1", "1.2.1.2", "1.3", "2", "2.1"]);
    expect(labels("legal")).toEqual(["1", "1.1", "1.2", "1.2.1", "(a)", "(i)", "(A)", "(b)", "1.3", "2", "2.1"]);
    expect(labels("legal-article")).toEqual([
      "Article I",
      "Section 1.01",
      "Section 1.02",
      "(a)",
      "(i)",
      "(A)",
      "(1)",
      "(ii)",
      "Section 1.03",
      "Article II",
      "Section 2.01",
    ]);
  });

  it("has a preset setting that overrides the per-level settings", () => {
    const config = headingNumbersConfig({ enabled: true, preset: "legal", styles: ["upper-roman"], separator: "-" });
    expect(config.styles[0]).toBe("decimal");
    expect(config.separator).toBe(".");
    expect(headingNumbersConfig({ enabled: true, preset: "custom", styles: ["upper-roman"] }).styles[0]).toBe("upper-roman");
    expect(headingNumbersConfig({ preset: "bogus" }).styles).toEqual([...DEFAULT_HEADING_NUMBER_STYLES]);
  });

  it("finds the preset a set of levels is", () => {
    for (const name of HEADING_NUMBER_PRESET_NAMES) expect(presetOf(presetLevels(name))).toBe(name);
    // The default settings are the outline preset.
    expect(presetOf(headingNumbersConfig({}))).toBe("outline");
    // `full` on a plain style is what `auto` means.
    expect(presetOf({ ...presetLevels("decimal"), parents: ["full", "full", "full", "full", "full", "full"] })).toBe("decimal");
    expect(presetOf({ ...presetLevels("legal"), separator: "-" })).toBe("custom");
  });

  it("formats the new styles", () => {
    expect(formatCounter(1, "decimal-leading-zero")).toBe("01");
    expect(formatCounter(12, "decimal-leading-zero")).toBe("12");
    expect(formatCounter(3, "parenthesized-decimal")).toBe("(3)");
    expect(formatCounter(3, "parenthesized-lower-alpha")).toBe("(c)");
    expect(formatCounter(3, "parenthesized-upper-alpha")).toBe("(C)");
    expect(formatCounter(4, "parenthesized-lower-roman")).toBe("(iv)");
    expect(formatCounter(4, "parenthesized-upper-roman")).toBe("(IV)");
    expect(formatCounter(2, "decimal-paren")).toBe("2)");
    expect(formatCounter(2, "lower-alpha-paren")).toBe("b)");
    expect(formatCounter(2, "upper-roman-paren")).toBe("II)");
  });

  describe("own and full", () => {
    const config = (styles: HeadingNumberStyle[], parents: string[], prefixes: string[] = []) =>
      headingNumbersConfig({ enabled: true, styles, parents, prefixes });

    it("joins a full path with the separator, but not before a parenthesized part", () => {
      const c = config(["decimal", "decimal-leading-zero", "parenthesized-lower-alpha", "parenthesized-lower-roman"], ["auto", "full", "full", "full"]);
      expect(headingNumberLabels([1, 2, 3, 4], c)).toEqual(["1", "1.01", "1.01(a)", "1.01(a)(i)"]);
    });

    it("shows only the level's own label with own, and by default for parenthesized styles", () => {
      const c = config(["decimal", "decimal", "parenthesized-lower-alpha", "lower-roman"], ["auto", "own", "auto", "own"]);
      expect(headingNumberLabels([1, 2, 3, 4], c)).toEqual(["1", "1", "(a)", "i"]);
    });

    it("writes every parent as plain digits with legal", () => {
      const c = config(["upper-roman", "lower-alpha", "decimal-leading-zero"], ["auto", "auto", "legal"]);
      expect(headingNumberLabels([1, 2, 3], c)).toEqual(["I", "I.a", "1.1.01"]);
    });

    it("keeps a right-paren part joined by the separator", () => {
      const c = config(["decimal", "lower-alpha-paren"], ["auto", "auto"]);
      expect(headingNumberLabels([1, 2], c)).toEqual(["1", "1.a)"]);
    });

    it("puts a prefix before its own level's label only", () => {
      const c = config(["upper-roman", "decimal"], ["auto", "legal"], ["Part ", "§ "]);
      expect(headingNumberLabels([1, 2, 1, 2], c)).toEqual(["Part I", "§ 1.1", "Part II", "§ 2.1"]);
    });

    it("leaves out skipped levels and none levels from a path", () => {
      const c = config(["decimal", "none", "decimal", "parenthesized-lower-alpha"], ["auto", "auto", "auto", "full"]);
      expect(headingNumberLabels([1, 2, 3, 4, 1, 4], c)).toEqual(["1", null, "1.1", "1.1(a)", "2", "2(a)"]);
    });
  });
});

describe("extended property grammar", () => {
  const settings = headingNumbersConfig({ enabled: false });

  it("accepts preset names as bare words", () => {
    for (const name of HEADING_NUMBER_PRESET_NAMES) {
      expect(effectiveHeadingNumbers(settings, name).config).toEqual({ enabled: true, ...presetLevels(name) });
    }
    expect(parseNumberingProperty("custom")).toBeNull();
  });

  it("parses padding, parens, modes and prefixes", () => {
    expect(parseNumberingProperty('"[Article ]I.[Section ]01#.(a).(i).(A).(1)"')).toEqual({
      enabled: true,
      ...presetLevels("legal-article"),
    });
    expect(parseNumberingProperty('"1.1.1.(a).(i).(A)"')).toEqual({ enabled: true, ...presetLevels("legal") });
    expect(parseNumberingProperty('"1-a)+-(i)!-I)"')).toEqual({
      enabled: true,
      styles: ["decimal", "lower-alpha-paren", "parenthesized-lower-roman", "upper-roman-paren"],
      parents: ["auto", "full", "own", "auto"],
      prefixes: ["", "", "", ""],
      separator: "-",
    });
    expect(parseNumberingProperty('"[Ch. ]1"')).toEqual({ enabled: true, styles: ["decimal"], parents: ["auto"], prefixes: ["Ch. "] });
  });

  it("keeps the old simple strings exactly as before", () => {
    const old = (styles: HeadingNumberStyle[], separator?: string) => ({
      enabled: true,
      styles,
      parents: styles.map(() => "auto"),
      prefixes: styles.map(() => ""),
      ...(separator === undefined ? {} : { separator }),
    });
    expect(parseNumberingProperty('"1.a.i"')).toEqual(old(["decimal", "lower-alpha", "lower-roman"], "."));
    expect(parseNumberingProperty("I-1-a")).toEqual(old(["upper-roman", "decimal", "lower-alpha"], "-"));
    expect(parseNumberingProperty('"_.1.a"')).toEqual(old(["none", "decimal", "lower-alpha"], "."));
    expect(parseNumberingProperty('"1ai"')).toEqual(old(["decimal", "lower-alpha", "lower-roman"], ""));
    expect(parseNumberingProperty("'I / 1'")).toEqual(old(["upper-roman", "decimal"], " / "));
    expect(parseNumberingProperty("A")).toEqual(old(["upper-alpha"]));
    const config = headingNumbersConfig({ enabled: true });
    expect(headingNumberLabels([1, 2, 3], effectiveHeadingNumbers(config, '"I-1-a"').config)).toEqual(["I", "I-1", "I-1-a"]);
  });

  it("rejects malformed levels", () => {
    for (const raw of ['"[Article I"', '"(1.a"', '"(b)"', '"1.(a"', '"1.a+.i+.1+.a+.i+.1"', '"1+!"', '"0.1"']) {
      expect(parseNumberingProperty(raw), raw).toBeNull();
    }
  });

  it("writes the shortest form", () => {
    const on = (levels: NumberingLevels): NumberingChoice => ({ mode: "on", ...levels });
    expect(formatNumberingProperty(on(presetLevels("outline")), settings)).toBe("on");
    expect(formatNumberingProperty(on(presetLevels("legal")), settings)).toBe("legal");
    expect(formatNumberingProperty(on(presetLevels("legal-article")), settings)).toBe("legal-article");
    expect(formatNumberingProperty(on(presetLevels("legal")), headingNumbersConfig({ preset: "legal" }))).toBe("on");
    const custom = presetLevels("legal-article");
    custom.prefixes[0] = "ARTICLE ";
    expect(formatNumberingProperty(on(custom), settings)).toBe('"[ARTICLE ]I.[Section ]01#.(a).(i).(A).(1)"');
  });

  it("round-trips dialog states through the property", () => {
    const states: NumberingLevels[] = [
      ...HEADING_NUMBER_PRESET_NAMES.map(presetLevels),
      {
        styles: ["upper-roman", "decimal-leading-zero", "lower-alpha-paren", "parenthesized-upper-roman", "none", "decimal-paren"],
        parents: ["own", "legal", "full", "full", "auto", "own"],
        prefixes: ['Chapter "', "Sec. ", "", "[x", "", "\\"],
        separator: " / ",
      },
      { ...presetLevels("legal"), separator: "" },
    ];
    for (const levels of states) {
      const choice: NumberingChoice = { mode: "on", ...levels };
      const raw = formatNumberingProperty(choice, settings);
      const back = numberingChoice(raw ?? undefined, settings).choice;
      expect(back.mode, raw ?? "").toBe("on");
      expect(sameLevels(back as NumberingLevels, levels), raw ?? "").toBe(true);
    }
  });

  it("refuses prefixes the format can't hold", () => {
    expect(prefixProblem("Article ")).toBeNull();
    expect(prefixProblem("a]b")).toMatch(/\]/);
    expect(prefixProblem("a\nb")).toMatch(/line/);
    expect(separatorProblem("(")).toMatch(/can't contain/);
    expect(separatorProblem("+")).toMatch(/can't contain/);
  });
});
