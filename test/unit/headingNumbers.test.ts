import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEADING_NUMBER_SEPARATOR,
  DEFAULT_HEADING_NUMBER_STYLES,
  effectiveHeadingNumbers,
  formatNumberingProperty,
  HEADING_NUMBER_STYLES,
  numberingChoice,
  parseNumberingProperty,
  separatorProblem,
  type NumberingChoice,
  formatCounter,
  headingNumberLabels,
  headingNumbersConfig,
  type HeadingNumbersConfig,
  type HeadingNumberStyle,
} from "../../src/headingNumbers";

const on = (styles: HeadingNumberStyle[] = [...DEFAULT_HEADING_NUMBER_STYLES], separator = "."): HeadingNumbersConfig => ({
  enabled: true,
  styles,
  separator,
});

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
    }
  });
});

describe("ken-heading-numbering property", () => {
  const settings = headingNumbersConfig({ enabled: false });
  const custom = (styles: HeadingNumberStyle[], separator = "."): NumberingChoice => ({ mode: "on", styles, separator });

  it("parses on and off, plain or quoted, in any case", () => {
    for (const raw of ["off", "false", "OFF", "False", '"off"', "'off'"]) expect(parseNumberingProperty(raw)).toEqual({ enabled: false });
    for (const raw of ["on", "true", "On", "TRUE", '"on"']) expect(parseNumberingProperty(raw)).toEqual({ enabled: true, styles: [] });
  });

  it("parses a format string: one style token per level, H1 first", () => {
    expect(parseNumberingProperty('"1.a.i.1.a.i"')).toEqual({
      enabled: true,
      styles: ["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman"],
      separator: ".",
    });
    expect(parseNumberingProperty("1-A-i")).toEqual({ enabled: true, styles: ["decimal", "upper-alpha", "lower-roman"], separator: "-" });
    expect(parseNumberingProperty("'I / 1'")).toEqual({ enabled: true, styles: ["upper-roman", "decimal"], separator: " / " });
    expect(parseNumberingProperty('"_.1.a"')).toEqual({ enabled: true, styles: ["none", "decimal", "lower-alpha"], separator: "." });
    expect(parseNumberingProperty('"1ai"')).toEqual({ enabled: true, styles: ["decimal", "lower-alpha", "lower-roman"], separator: "" });
  });

  it("takes the separator from the settings for a single level", () => {
    expect(parseNumberingProperty("I")).toEqual({ enabled: true, styles: ["upper-roman"] });
    expect(parseNumberingProperty("1")).toEqual({ enabled: true, styles: ["decimal"] });
  });

  it("unescapes quoted strings", () => {
    expect(parseNumberingProperty('"1\\"a"')).toEqual({ enabled: true, styles: ["decimal", "lower-alpha"], separator: '"' });
    expect(parseNumberingProperty("'1''a'")).toEqual({ enabled: true, styles: ["decimal", "lower-alpha"], separator: "'" });
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
      expect(effectiveHeadingNumbers(on, '"1.a"').config).toEqual({
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
        custom(["lower-alpha", ...DEFAULT_HEADING_NUMBER_STYLES.slice(1)], ")"),
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
