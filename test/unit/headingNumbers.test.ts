import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEADING_NUMBER_STYLES,
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
