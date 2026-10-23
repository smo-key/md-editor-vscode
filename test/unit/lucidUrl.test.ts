// Lucid link recognition: the allowlist the webview previews and the host
// re-checks before opening anything (src/lucidUrl.ts).
import { describe, expect, it } from "vitest";
import {
  editUrl,
  embedUrl,
  isLucidHost,
  LUCID_HOSTS,
  lucidPreviewMode,
  openUrl,
  parseLucidUrl,
  publishedImageMarkdown,
  publishedImageUrl,
  type LucidDocumentRef,
} from "../../src/lucidUrl";

const ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const UPPER = ID.toUpperCase();
const PID = "9c1e2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

function doc(href: string): LucidDocumentRef {
  const ref = parseLucidUrl(href);
  if (ref?.kind !== "document") throw new Error(`not a document: ${href}`);
  return ref;
}

describe("parseLucidUrl: accepted document links", () => {
  const cases: [string, string, "lucidchart" | "lucidspark" | "unknown"][] = [
    ["Lucidchart edit", `https://lucid.app/lucidchart/${ID}/edit`, "lucidchart"],
    ["Lucidchart view", `https://lucid.app/lucidchart/${ID}/view`, "lucidchart"],
    ["Lucidchart comment", `https://lucid.app/lucidchart/${ID}/comment`, "lucidchart"],
    ["Lucidspark edit", `https://lucid.app/lucidspark/${ID}/edit`, "lucidspark"],
    ["Lucidspark view", `https://lucid.app/lucidspark/${ID}/view`, "lucidspark"],
    ["documents/edit", `https://lucid.app/documents/edit/${ID}`, "unknown"],
    ["documents/view", `https://lucid.app/documents/view/${ID}`, "unknown"],
    ["documents/comment", `https://lucid.app/documents/comment/${ID}`, "unknown"],
    ["embedded viewer", `https://lucid.app/documents/embedded/${ID}`, "unknown"],
    ["embedded viewer with page", `https://lucid.app/documents/embedded/${ID}/0_0`, "unknown"],
    ["embeddedchart", `https://lucid.app/documents/embeddedchart/${ID}`, "unknown"],
    ["documents/view with page segment", `https://lucid.app/documents/view/${ID}/0`, "unknown"],
    ["legacy www host", `https://www.lucidchart.com/documents/view/${ID}`, "unknown"],
    ["legacy bare host", `https://lucidchart.com/documents/edit/${ID}`, "unknown"],
    ["legacy app host", `https://app.lucidchart.com/lucidchart/${ID}/edit`, "lucidchart"],
    ["trailing slash", `https://lucid.app/lucidchart/${ID}/edit/`, "lucidchart"],
    ["extra segments after the action", `https://lucid.app/lucidchart/${ID}/edit/page/2`, "lucidchart"],
    ["upper-case host", `https://LUCID.APP/lucidchart/${ID}/edit`, "lucidchart"],
    ["explicit port 443", `https://lucid.app:443/lucidchart/${ID}/edit`, "lucidchart"],
    ["surrounding whitespace", `  https://lucid.app/lucidchart/${ID}/edit \n`, "lucidchart"],
  ];
  for (const [name, href, product] of cases) {
    it(name, () => {
      const ref = doc(href);
      expect(ref.id).toBe(ID);
      expect(ref.product).toBe(product);
      expect(ref.invitationId).toBeUndefined();
    });
  }

  it("lower-cases an upper-case id", () => {
    expect(doc(`https://lucid.app/lucidchart/${UPPER}/edit`).id).toBe(ID);
  });

  it("keeps the invitationId and ignores other query parameters and the fragment", () => {
    const ref = doc(`https://lucid.app/lucidchart/${ID}/edit?viewport_loc=-1%2C2&invitationId=inv_abc-123&page=0_0#frag`);
    expect(ref.id).toBe(ID);
    expect(ref.invitationId).toBe("inv_abc-123");
  });

  it("ignores an empty invitationId", () => {
    expect(doc(`https://lucid.app/lucidchart/${ID}/edit?invitationId=`).invitationId).toBeUndefined();
  });

  it("keeps a fragment-only link", () => {
    expect(doc(`https://lucid.app/lucidchart/${ID}/edit#page=2`).id).toBe(ID);
  });

  it("href is the parsed URL, with whitespace and default port gone", () => {
    expect(doc(` https://lucid.app:443/lucidchart/${ID}/edit?x=1#y `).href).toBe(
      `https://lucid.app/lucidchart/${ID}/edit?x=1#y`,
    );
  });
});

describe("parseLucidUrl: published images", () => {
  it("recognizes a published image on lucid.app", () => {
    const href = `https://lucid.app/publicSegments/view/${PID}/image.png`;
    expect(parseLucidUrl(href)).toEqual({ kind: "image", publicId: PID, href });
  });

  it("lower-cases the public id and tolerates a query", () => {
    const ref = parseLucidUrl(`https://lucid.app/publicSegments/view/${PID.toUpperCase()}/image.png?v=1`);
    expect(ref).toMatchObject({ kind: "image", publicId: PID });
  });

  it("rejects images on legacy hosts, without image.png, or with a bad id", () => {
    expect(parseLucidUrl(`https://www.lucidchart.com/publicSegments/view/${PID}/image.png`)).toBeNull();
    expect(parseLucidUrl(`https://lucid.app/publicSegments/view/${PID}`)).toBeNull();
    expect(parseLucidUrl(`https://lucid.app/publicSegments/view/${PID}/image.jpg`)).toBeNull();
    expect(parseLucidUrl(`https://lucid.app/publicSegments/view/${PID}/image.png/x`)).toBeNull();
    expect(parseLucidUrl(`https://lucid.app/publicSegments/view/not-a-uuid/image.png`)).toBeNull();
    expect(parseLucidUrl(`http://lucid.app/publicSegments/view/${PID}/image.png`)).toBeNull();
  });
});

describe("parseLucidUrl: rejected", () => {
  const rejected: [string, string][] = [
    ["http", `http://lucid.app/lucidchart/${ID}/edit`],
    ["look-alike host suffix", `https://lucid.app.evil.com/lucidchart/${ID}/edit`],
    ["look-alike host prefix", `https://evillucid.app/lucidchart/${ID}/edit`],
    ["subdomain of lucid.app", `https://evil.lucid.app/lucidchart/${ID}/edit`],
    ["lucid.app in the path", `https://evil.com/lucid.app/lucidchart/${ID}/edit`],
    ["lucid.app in the query", `https://evil.com/?u=https://lucid.app/lucidchart/${ID}/edit`],
    ["lucid.app as userinfo", `https://lucid.app@evil.com/lucidchart/${ID}/edit`],
    ["userinfo on lucid.app", `https://user@lucid.app/lucidchart/${ID}/edit`],
    ["password on lucid.app", `https://user:pw@lucid.app/lucidchart/${ID}/edit`],
    ["non-default port", `https://lucid.app:8443/lucidchart/${ID}/edit`],
    ["trailing-dot host", `https://lucid.app./lucidchart/${ID}/edit`],
    ["protocol-relative", `//lucid.app/lucidchart/${ID}/edit`],
    ["no scheme", `lucid.app/lucidchart/${ID}/edit`],
    ["javascript:", `javascript:alert(1)//https://lucid.app/lucidchart/${ID}/edit`],
    ["data:", `data:text/html,https://lucid.app/lucidchart/${ID}/edit`],
    ["vscode:", `vscode://LucidSoftware.lucidforvscode/open-document?url=https://lucid.app/lucidchart/${ID}/edit`],
    ["short id", "https://lucid.app/lucidchart/abc-123/edit"],
    ["id with a bad character", `https://lucid.app/lucidchart/${ID.slice(0, -1)}g/edit`],
    ["id with no dashes", `https://lucid.app/lucidchart/${ID.replace(/-/g, "")}/edit`],
    ["id too long", `https://lucid.app/lucidchart/${ID}0/edit`],
    ["percent-encoded id", `https://lucid.app/lucidchart/${encodeURIComponent(ID).replace("3", "%33")}/edit`],
    ["product path without action", `https://lucid.app/lucidchart/${ID}`],
    ["unknown action", `https://lucid.app/lucidchart/${ID}/delete`],
    ["unknown documents verb", `https://lucid.app/documents/delete/${ID}`],
    ["Lucidscale", `https://lucid.app/lucidscale/${ID}/edit`],
    ["invitation accept", "https://lucid.app/invitations/accept/inv_x"],
    ["folder", `https://lucid.app/folder/${ID}`],
    ["users", "https://lucid.app/users/login"],
    ["root", "https://lucid.app/"],
    ["upper-case path", `https://lucid.app/Lucidchart/${ID}/edit`],
    ["empty", ""],
    ["garbage", "not a url"],
  ];
  for (const [name, href] of rejected) {
    it(name, () => expect(parseLucidUrl(href)).toBeNull());
  }

  it("rejects non-strings", () => {
    expect(parseLucidUrl(undefined as unknown as string)).toBeNull();
    expect(parseLucidUrl(42 as unknown as string)).toBeNull();
  });
});

describe("isLucidHost", () => {
  it("matches exactly the allowlist, case-insensitively", () => {
    for (const h of LUCID_HOSTS) expect(isLucidHost(h)).toBe(true);
    expect(isLucidHost("Lucid.App")).toBe(true);
    expect(isLucidHost("lucid.app.evil.com")).toBe(false);
    expect(isLucidHost("x.lucid.app")).toBe(false);
    expect(isLucidHost("lucidchart.com.evil")).toBe(false);
  });
});

describe("embedUrl", () => {
  it("normalizes every document form to the embedded viewer on lucid.app", () => {
    const want = `https://lucid.app/documents/embedded/${ID}`;
    for (const href of [
      `https://lucid.app/lucidchart/${ID}/edit?viewport_loc=1#x`,
      `https://lucid.app/lucidspark/${UPPER}/view`,
      `https://www.lucidchart.com/documents/view/${ID}`,
      `https://app.lucidchart.com/documents/embeddedchart/${ID}/0_0`,
      `https://lucid.app/documents/embedded/${ID}`,
    ]) {
      expect(embedUrl(doc(href))).toBe(want);
    }
  });

  it("keeps only the invitationId, encoded", () => {
    expect(embedUrl(doc(`https://lucid.app/lucidchart/${ID}/edit?a=1&invitationId=inv_x&b=2`))).toBe(
      `https://lucid.app/documents/embedded/${ID}?invitationId=inv_x`,
    );
    expect(embedUrl(doc(`https://lucid.app/lucidchart/${ID}/edit?invitationId=a%26b%3Dc`))).toBe(
      `https://lucid.app/documents/embedded/${ID}?invitationId=a%26b%3Dc`,
    );
  });
});

describe("editUrl", () => {
  it("uses a lucid.app edit link exactly as written", () => {
    const href = `https://lucid.app/lucidchart/${ID}/edit?viewport_loc=-1%2C2&invitationId=inv_x&page=0_0#p`;
    expect(editUrl(doc(href))).toBe(href);
  });

  it("turns a lucid.app view or comment link into its edit link, keeping query and fragment", () => {
    expect(editUrl(doc(`https://lucid.app/lucidchart/${ID}/view?page=0_0#p`))).toBe(
      `https://lucid.app/lucidchart/${ID}/edit?page=0_0#p`,
    );
    expect(editUrl(doc(`https://lucid.app/lucidspark/${ID}/comment`))).toBe(`https://lucid.app/lucidspark/${ID}/edit`);
  });

  it("builds the canonical edit link for embedded, documents/… and legacy links", () => {
    expect(editUrl(doc(`https://lucid.app/documents/embedded/${ID}`))).toBe(`https://lucid.app/lucidchart/${ID}/edit`);
    expect(editUrl(doc(`https://www.lucidchart.com/documents/edit/${UPPER}?invitationId=inv_x&z=1`))).toBe(
      `https://lucid.app/lucidchart/${ID}/edit?invitationId=inv_x`,
    );
    expect(editUrl(doc(`https://app.lucidchart.com/lucidspark/${ID}/edit`))).toBe(`https://lucid.app/lucidspark/${ID}/edit`);
  });
});

describe("openUrl", () => {
  it("opens a lucid.app view, edit or comment link as written", () => {
    for (const href of [
      `https://lucid.app/lucidchart/${ID}/view?page=1#x`,
      `https://lucid.app/lucidspark/${ID}/edit`,
      `https://lucid.app/documents/view/${ID}`,
      `https://lucid.app/documents/comment/${ID}`,
    ]) {
      expect(openUrl(doc(href))).toBe(href);
    }
  });

  it("opens the edit link for embedded and legacy links", () => {
    expect(openUrl(doc(`https://lucid.app/documents/embedded/${ID}`))).toBe(`https://lucid.app/lucidchart/${ID}/edit`);
    expect(openUrl(doc(`https://www.lucidchart.com/documents/view/${ID}`))).toBe(`https://lucid.app/lucidchart/${ID}/edit`);
  });

  it("opens a published image as itself", () => {
    const href = `https://lucid.app/publicSegments/view/${PID}/image.png`;
    const ref = parseLucidUrl(href)!;
    expect(openUrl(ref)).toBe(href);
  });
});

describe("published image form", () => {
  it("builds the image URL", () => {
    expect(publishedImageUrl(PID.toUpperCase())).toBe(`https://lucid.app/publicSegments/view/${PID}/image.png`);
    expect(parseLucidUrl(publishedImageUrl(PID))).toMatchObject({ kind: "image", publicId: PID });
  });

  it("refuses to build one from a non-UUID id", () => {
    expect(() => publishedImageUrl("../evil")).toThrow();
  });

  it("builds the linked-image Markdown, escaping the title", () => {
    const ref = doc(`https://lucid.app/lucidchart/${ID}/edit`);
    expect(publishedImageMarkdown("Payments [v2]", PID, ref)).toBe(
      `[![Payments \\[v2\\]](https://lucid.app/publicSegments/view/${PID}/image.png)](https://lucid.app/lucidchart/${ID}/edit)`,
    );
  });
});

describe("lucidPreviewMode", () => {
  it("accepts the three modes and defaults to auto", () => {
    expect(lucidPreviewMode("auto")).toBe("auto");
    expect(lucidPreviewMode("onClick")).toBe("onClick");
    expect(lucidPreviewMode("off")).toBe("off");
    expect(lucidPreviewMode(undefined)).toBe("auto");
    expect(lucidPreviewMode("OFF")).toBe("auto");
    expect(lucidPreviewMode(false)).toBe("auto");
  });
});
