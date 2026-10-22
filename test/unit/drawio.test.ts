import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { diagramXml, isDrawioSrc } from "../../webview/drawio";

describe("draw.io helpers", () => {
  it("recognises diagram images", () => {
    expect(isDrawioSrc("_Images/flow.drawio.svg")).toBe(true);
    expect(isDrawioSrc("My%20Flow.drawio.png?v=2")).toBe(true);
    expect(isDrawioSrc("photo.svg")).toBe(false);
    expect(isDrawioSrc("notes.drawio")).toBe(false);
    expect(isDrawioSrc(null)).toBe(false);
  });

  it("reads the diagram source out of a .drawio.svg", () => {
    const xml = diagramXml(readFileSync("test/fixtures/flow.drawio.svg", "utf8"));
    expect(xml).toMatch(/^<mxfile/);
    expect(diagramXml("<svg><g/></svg>")).toBeNull();
  });
});
