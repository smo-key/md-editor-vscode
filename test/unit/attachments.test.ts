import { describe, expect, it } from "vitest";

import {
  attachmentName,
  docDir,
  encodeHref,
  extFromMime,
  isImageFile,
  isImagePath,
  relativeTo,
  resolveSrc,
} from "../../webview/markdown/attachments";

describe("docDir", () => {
  it("is the folder holding the document", () => {
    expect(docDir("notes/2026/plan.md")).toBe("notes/2026");
  });

  it("is the project root for a top-level document", () => {
    expect(docDir("plan.md")).toBe("");
  });
});

describe("extFromMime", () => {
  it("maps the common image types", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/svg+xml")).toBe("svg");
    expect(extFromMime("application/pdf")).toBe("pdf");
  });

  it("ignores MIME parameters and case", () => {
    expect(extFromMime("Image/PNG; charset=binary")).toBe("png");
  });

  it("falls back to bin for unknown or empty types", () => {
    expect(extFromMime("")).toBe("bin");
    expect(extFromMime("application/x-unknown-thing")).toBe("bin");
  });
});

describe("isImagePath / isImageFile", () => {
  it("recognises image extensions case-insensitively", () => {
    expect(isImagePath("a/b/Shot.PNG")).toBe(true);
    expect(isImagePath("x.jpeg")).toBe(true);
    expect(isImagePath("x.svg")).toBe(true);
    expect(isImagePath("x.pdf")).toBe(false);
    expect(isImagePath("png")).toBe(false);
  });

  it("trusts the MIME type first, then the extension", () => {
    expect(isImageFile({ name: "clip", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "photo.heic.jpg", type: "" })).toBe(true);
    expect(isImageFile({ name: "doc.pdf", type: "application/pdf" })).toBe(false);
  });
});

describe("attachmentName", () => {
  // Local-time constructor so the stamp is the same in every timezone.
  const now = new Date(2026, 9, 9, 15, 30, 5);

  it("names a clipboard image after the document and the time", () => {
    expect(
      attachmentName({ name: "image.png", type: "image/png" }, "notes/Plan.md", now),
    ).toBe("Plan-pasted-20261009-153005.png");
  });

  it("names a nameless paste the same way, extension from the MIME", () => {
    expect(
      attachmentName({ name: "", type: "image/jpeg" }, "Plan.md", now),
    ).toBe("Plan-pasted-20261009-153005.jpg");
  });

  it("falls back to a generic stem without a document", () => {
    expect(attachmentName({ name: "", type: "image/png" }, undefined, now)).toBe(
      "pasted-20261009-153005.png",
    );
  });

  it("keeps a real file's own name", () => {
    expect(
      attachmentName({ name: "My Shot.png", type: "image/png" }, "Plan.md", now),
    ).toBe("My Shot.png");
    expect(
      attachmentName({ name: "report.pdf", type: "application/pdf" }, "Plan.md", now),
    ).toBe("report.pdf");
  });
});

describe("relativeTo", () => {
  it("is the bare name for a sibling", () => {
    expect(relativeTo("notes", "notes/shot.png")).toBe("shot.png");
    expect(relativeTo("", "shot.png")).toBe("shot.png");
  });

  it("descends into subfolders", () => {
    expect(relativeTo("notes", "notes/img/shot.png")).toBe("img/shot.png");
    expect(relativeTo("", "img/shot.png")).toBe("img/shot.png");
  });

  it("climbs out with ../", () => {
    expect(relativeTo("notes", "assets/shot.png")).toBe("../assets/shot.png");
    expect(relativeTo("a/b/c", "a/x.png")).toBe("../../x.png");
    expect(relativeTo("a/b", "x.png")).toBe("../../x.png");
  });

  it("does not confuse a folder with a same-prefix sibling", () => {
    expect(relativeTo("note", "notes/x.png")).toBe("../notes/x.png");
  });
});

describe("encodeHref", () => {
  it("percent-encodes spaces and unsafe characters per segment", () => {
    expect(encodeHref("My Shot.png")).toBe("My%20Shot.png");
    expect(encodeHref("../my dir/a#b?.png")).toBe("../my%20dir/a%23b%3F.png");
  });

  it("encodes parentheses so the Markdown link stays balanced", () => {
    expect(encodeHref("shot (1).png")).toBe("shot%20%281%29.png");
  });

  it("leaves plain names alone", () => {
    expect(encodeHref("img/shot-1_a.png")).toBe("img/shot-1_a.png");
  });
});

describe("resolveSrc", () => {
  it("resolves a sibling name against the document's folder", () => {
    expect(resolveSrc("notes/plan.md", "shot.png")).toBe("notes/shot.png");
    expect(resolveSrc("plan.md", "shot.png")).toBe("shot.png");
  });

  it("handles ./ and ../", () => {
    expect(resolveSrc("notes/plan.md", "./img/shot.png")).toBe("notes/img/shot.png");
    expect(resolveSrc("notes/sub/plan.md", "../assets/x.png")).toBe("notes/assets/x.png");
  });

  it("decodes percent-escapes", () => {
    expect(resolveSrc("notes/plan.md", "My%20Shot.png")).toBe("notes/My Shot.png");
    expect(resolveSrc("plan.md", "shot%20%281%29.png")).toBe("shot (1).png");
  });

  it("round-trips encodeHref(relativeTo(...))", () => {
    const target = "assets/my pics/shot (2).png";
    const href = encodeHref(relativeTo("notes/deep", target));
    expect(resolveSrc("notes/deep/plan.md", href)).toBe(target);
  });

  it("refuses paths that climb out of the project", () => {
    expect(resolveSrc("plan.md", "../outside.png")).toBeNull();
    expect(resolveSrc("a/plan.md", "../../outside.png")).toBeNull();
  });

  it("ignores absolute, external and empty sources", () => {
    for (const src of [
      "",
      "https://example.com/a.png",
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "blob:http://localhost/123",
      "asset://localhost/%2Fx.png",
      "file:///tmp/x.png",
      "mailto:a@b.c",
      "#heading",
      "/abs/x.png",
      "//cdn.example.com/x.png",
    ]) {
      expect(resolveSrc("notes/plan.md", src)).toBeNull();
    }
  });

  it("drops a query or fragment before resolving", () => {
    expect(resolveSrc("plan.md", "x.png?v=2")).toBe("x.png");
    expect(resolveSrc("plan.md", "doc.pdf#page=2")).toBe("doc.pdf");
  });

  it("returns null on a malformed escape", () => {
    expect(resolveSrc("plan.md", "bad%E0%A4%A.png")).toBeNull();
  });
});
