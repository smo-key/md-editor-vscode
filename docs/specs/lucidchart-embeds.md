# Lucidchart embeds: design spec

Status: draft for review · 2026-10-23 · branch `docs/spec-lucidchart`

User request: *"Would it be possible to implement an embed for Lucidchart as well, so we can preview Lucidcharts here, and click Edit to edit them, when their links are included?"*

## 1. Summary

A Lucid link that stands alone in its paragraph gets a live preview under it, with **Edit**, **Open in Lucidchart** and **Reload** buttons. A Lucid link inside a sentence stays an ordinary link. The Markdown is not changed: the link is still a link (GitHub shows a link), and the preview is a ProseMirror *decoration*. It never touches the document, so collaboration and the "opening is not an edit" rule are not affected.

- **Preview** loads Lucid's embedded viewer, `https://lucid.app/documents/embedded/<id>`, in a sandboxed iframe. Lucid allows `vscode-webview:` as a frame ancestor for this path; it does not allow it for the editor (`/lucidchart/<id>/edit`) or for the sign-in page. The viewer shows a diagram without sign-in only when its owner has *activated the embed code* in Lucid. Without that, the frame shows Lucid's own "request access / log in" screen. That screen cannot be detected from outside the frame, and nobody can sign in through it (see §3). So every preview has a fixed hint line under it, and the published-image form is offered as the reliable option.
- **Published image** form, `[![Title](https://lucid.app/publicSegments/view/<pid>/image.png)](https://lucid.app/lucidchart/<id>/edit)`, already renders as an image, both here and on GitHub. The image is anonymous and CORS-open. It gets the same Edit and Open buttons, which take the document link from the wrapping link.
- **Edit** can't happen inside our webview (§3.4). It hands the document to **Lucid for VS Code** (`LucidSoftware.lucidforvscode`, Lucid's own extension, which edits in a VS Code panel after its own sign-in) when that extension is installed. Otherwise it opens the browser with `vscode.env.openExternal`. When the user comes back to the editor, the preview reloads.
- As a prerequisite, the link syntax is kept as the author wrote it. Today a bare `https://…` is re-saved as `<https://…>`, and `[url](url)` too, as soon as any other edit is made (verified, §3.6).

## 2. Goals and non-goals

**Goals**

1. Preview a Lucidchart document from its link, in place, without changing the file.
2. Give each preview an Edit button that takes the user somewhere they can actually edit.
3. Round-trip every supported form byte-for-byte, including after unrelated edits elsewhere in the file.
4. Fail visibly and usefully: offline, unreachable, not shared or not activated, or feature turned off.
5. Allow only Lucid's hosts in frames (allowlist) and grant no capability the viewer doesn't need.

**Non-goals (v1)**

- Signing in to Lucid from the editor, or token-based embeds through our own OAuth client. This is future work, §13 Q4.
- Editing inside the Ken editor's own webview.
- Creating Lucid documents or inserting embeds from a slash command. Pasting a link on its own line is the insert gesture.
- Lucidspark boards and Lucidscale models. Their URLs are recognized as Lucid links, but by default only Lucidchart is previewed (Q3).
- Choosing pages, or deep-linking a preview to a page. The viewer has its own page tabs.
- Theming the inside of Lucid's viewer: it is a cross-origin canvas. Only our own chrome follows `--vscode-*`.

## 3. Research findings (verified 2026-10-23)

Each item is marked **[verified]** (with how) or **[assumption]**.

### 3.1 URL shapes and frameability

Headers were fetched with `curl` and with same-origin `fetch()` from a `lucid.app` tab in Chrome (`credentials: "omit"`). Fake UUIDs were used for the auth paths, and real public IDs found in public GitHub repositories for the embed and image paths.

| Shape | Example | Anonymous result | `frame-ancestors` / XFO | Use |
| --- | --- | --- | --- | --- |
| Editor | `lucid.app/lucidchart/<uuid>/edit` | 303 → `/users/login` | `'self'` + Lucid training sites; `X-Frame-Options: SAMEORIGIN` | **Not frameable.** Link target only |
| Viewer | `lucid.app/lucidchart/<uuid>/view`, `/documents/view/<uuid>`, `/documents/edit/<uuid>` | → `/users/login` | login page: `'self'`, `SAMEORIGIN` | **Not frameable.** An iframe of `/view` showed Chrome's "refused to connect" page **[verified, Chrome iframe test]** |
| Embedded viewer | `lucid.app/documents/embedded/<uuid>`, `/documents/embeddedchart/<uuid>` | 200 (app shell); redirects in-host to `…/<uuid>/0_0` | `frame-ancestors https: http: vscode-webview: vscode-file: codex-sandbox:`, no XFO | **Frameable from VS Code webviews.** Rendered the diagram in a cross-origin iframe in Chrome **[verified]** |
| Cookie embed (dev API) | `lucid.app/embeds/link?clientId=…&document=…` | 400 without a valid client | same permissive `frame-ancestors` | Needs a registered OAuth client and *Authorized Embedding Domains* matched by referrer ([tutorial](https://developer.lucid.co/docs/tutorial-cookie-embeds)). A `vscode-webview://<random>` origin can't be registered. **Not used** |
| Token embed (dev API) | `lucid.app/embeds?token=…` | 401 without a token | same permissive `frame-ancestors` | Needs an OAuth2 user token and `POST api.lucid.co/embeds/token` ([tutorial](https://developer.lucid.co/docs/tutorial-token-embeds)). **Future (Q4)** |
| Published image | `lucid.app/publicSegments/view/<uuid>/image.png` | **200 `image/PNG`**, `Access-Control-Allow-Origin: *`, `Cache-Control: no-store` | n/a (an image) | **Works anonymously** under the existing `img-src https:` **[verified, curl on two public images]** |
| Legacy hosts | `www.lucidchart.com/documents/…`, `lucidchart.com`, `app.lucidchart.com` | (bot-protected from curl) | not checked | Accepted as Lucid hosts by Lucid's own extension (below). Previews are always loaded from `lucid.app`, so only `lucid.app` is needed in `frame-src` |

Lucid's CDN (Akamai) returns 403 "Access Denied" to `curl` for HTML paths, so the HTML checks were made from Chrome. That doesn't affect a webview, which is a real Chromium.

**An embedded doc does not need sign-in when its embed code is activated** **[partly verified]**. Public websites embed these URLs, for example climate-tech-handbook on GitHub. Lucid's help says to *activate* an embed code ("More › Embed › Activate Embed Code", [help](https://help.lucid.co/hc/en-us/articles/16181914460692)). A Lucid FAQ says a viewer without access sees a "request access" or "log in" message ([FAQ](https://developer.lucid.co/docs/embed-api-faqs)). In a Chrome `credentialless` iframe (no cookies), the doc stayed on "Loading…" or blank, so a purely anonymous load inside VS Code is **not yet proven**. Spike WP0 settles it.

### 3.2 Auth in a VS Code webview

- VS Code's webview frames are sandboxed `allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads`, with **no `allow-popups` and no `allow-top-navigation`** ([webviewElement.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/webviewElement.ts) line ~430; inner frame in [pre/index.html](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/index.html) ~1072) **[verified, source]**. Sandbox flags are inherited by nested frames. So a Lucid iframe inside our webview can't open a sign-in pop-up, can't navigate the top window, and its own "Open in Lucidchart" button can't open anything.
- The sign-in page refuses to be framed (`X-Frame-Options: SAMEORIGIN`) **[verified]**, so signing in inside the frame is impossible too.
- Lucid's own documentation says VS Code is a cookieless environment: "you'll still need to sign in once inside VS Code", and "active Lucid sessions don't persist after VS Code closes" ([Lucid help, updated 2026-10-20](https://help.lucid.co/hc/en-us/articles/53182437659412-Connect-Lucid-to-Visual-Studio-Code); [extension README](https://marketplace.visualstudio.com/items?itemName=LucidSoftware.lucidforvscode)). Their extension gets around this with its own OAuth flow and token-based embeds.
- **Conclusion:** cookie-based viewing ("signed-in user with access") is not available in the Ken webview. A preview shows only (a) docs with an activated embed code (WP0 to confirm) and (b) published images.

### 3.3 Lucid's Embed API

[External embeds](https://developer.lucid.co/docs/external-embeds) come in two kinds:

- **Cookie-based:** viewers need a Lucid account and access to the document, plus a registered client ID and embedding domain.
- **Token-based:** anyone can view. It needs OAuth2 (scope `lucidchart.document.app.picker.share.embed` or similar) and a short-lived, single-user session token minted per view at `POST https://api.lucid.co/embeds/token` with an `origin` field.

Lucid for VS Code does exactly the token route: `POST /v1/documents/{id}/embeds` with `accessLevel: "edit"`, then `/v1/embeds/token`, then `https://lucid.app/embeds?token=…` **[verified, its bundled `extension.js` v1.0.6]**. Doing the same in Ken would need our own Lucid developer app and OAuth client. Its secret could not be kept in an extension unless Lucid supports PKCE public clients **[assumption, unverified]**. There is also token refresh, SecretStorage and sign-in UI to build. That is a project of its own, so it is deferred (Q4).

**No oEmbed endpoint** was found ([search, 2026-10-23]; not in developer.lucid.co).

### 3.4 Editing

- In an iframe: the full editor (`/lucidchart/<id>/edit`) can't be framed (above). Editing in an embed (`mode=editor`, or a token embed with `viewerType: editor`) needs an authenticated Lucid session or token ([cookie tutorial](https://developer.lucid.co/docs/tutorial-cookie-embeds)), which §3.2 rules out. **Editing inside the Ken webview is not possible in v1.**
- **Lucid for VS Code** registers a URI handler `vscode://LucidSoftware.lucidforvscode/open-document?url=<encodeURIComponent(lucid URL)>`. Its URL parser accepts `https` URLs on `lucid.app`, `lucidchart.com`, `www.lucidchart.com` and `app.lucidchart.com`, with paths `/documents/{edit|view|comment}/<uuid>[/<page>]` or `/{lucidchart|lucidspark}/<uuid>/{edit|view|comment}`. It requires an RFC-4122 UUID document ID and takes the page from `?page=`, the 4th path segment or `viewport_loc` **[verified, reading `extension.js` of v1.0.6, 2026-10-08]**. It does **not** accept `/documents/embedded/…`, so we normalize before handing a link over. **This is an undocumented contract [assumption: stable]**. We therefore check for the extension at click time and fall back to the browser on any failure.
- Browser: `vscode.env.openExternal(Uri.parse(editUrl))`, the same path `provider.ts` `openLink` already uses for external links.

### 3.5 Codebase facts that shape the design

- The CSP (`src/provider.ts` `html()`) has `frame-src https://embed.diagrams.net` and `img-src … https:`. No other frame host is allowed.
- `webview/main.ts` line ~707 handles **every** `message` event as a `HostMessage` without checking `event.source` or `event.origin`. VS Code delivers host messages from the parent frame with `contentWindow.postMessage(msg, window.origin)` ([pre/index.html](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/index.html) ~1198). A framed third-party page can therefore post `{type: "update", text: …}` and replace the document. That exposure already exists with draw.io, but only while its overlay is open. A Lucid preview stays on screen, so this must be fixed first (WP3).
- `drawio.ts` shows the patterns to reuse: an Edit button added to block DOM from a plugin `view`, a 15 s "could not be reached" timeout, `button()` helpers and Lucide icons.
- `wikiLinks.ts` already makes a click on any `<a href>` in the editor post `openLink`, which the host opens externally.
- `remoteChange.ts` is for plugins that *normalize the document*. This design dispatches no transactions, so it has nothing to skip. A test asserts that it dispatches nothing.

### 3.6 Round-trip probe (scratch, outside the repo)

A throwaway vitest file was placed in the session scratchpad, mounting the real editor through `test/unit/editorEnv.ts` `mountEditor` and calling `crepe.getMarkdown()` (results as the webview would write them after an edit):

| Input | Output | Same |
| --- | --- | --- |
| `https://lucid.app/lucidchart/abc-123/edit?viewport_loc=1&invitationId=inv_x` (own paragraph) | `<https://lucid.app/…>` | **no** |
| `See https://lucid.app/… inline.` | `See <https://lucid.app/…> inline.` | **no** |
| `[https://lucid.app/…/edit](https://lucid.app/…/edit)` | `<https://lucid.app/…/edit>` | **no** |
| `<https://lucid.app/…/view>` | unchanged | yes |
| `[Architecture](https://lucid.app/…/edit)` | unchanged | yes |
| `[![Architecture](…/image.png)](…/edit)` | unchanged; parsed as `paragraph > image` (inline) with a `link` mark | yes |

Opening alone never writes (main.ts takes the serialized form as the baseline). But the first unrelated edit sends the whole document, and `minimalChange` then includes the rewritten link in its span. GitHub renders `<url>` and `url` the same, but the user sees a diff on a line they didn't touch. WP1 fixes this for every link, not only Lucid ones.

## 4. Decisions

1. **Decoration, not a new node.** The preview is a `Decoration.widget` placed after the paragraph, and the paragraph keeps its ordinary link. *Why:* no schema change, no serializer, no doc mutation. Collab peers and older versions see a plain link. Deleting or editing the link removes or updates the preview naturally. An atom node would need a custom serializer to keep the raw text, an editing UI for the URL, and a schema migration for Y.js peers.
2. **What becomes a preview:** a top-level paragraph (or one in a list item or blockquote) whose only content is one link to a recognized Lucid **document** URL. Whitespace and a trailing hard break are allowed. All three link forms count: bare literal, `<…>` and `[text](…)`. With `[text](…)` the text becomes the card title. A link with any other text beside it stays a link. Table cells are excluded: no previews there. *Why:* this matches the request ("on its own line"), and the user can't be surprised inside running text.
3. **The published-image form is also recognized:** a paragraph whose only content is an `image` with `src` on `lucid.app/publicSegments/view/<uuid>/image.png`, wrapped in a `link` mark to a Lucid document URL. It renders as the image it already is, plus a toolbar. A bare `publicSegments` image with no link gets an "Open image" action only (it has no document ID). *Why:* the image needs no sign-in and GitHub renders it, so this is the form we recommend in the hint.
4. **Embed URL:** for preview, every document link is normalized to `https://lucid.app/documents/embedded/<uuid>`, keeping only an `invitationId` query parameter if present. An `embedded`/`embeddedchart` link on any accepted host is normalized the same way. *Why:* one frame host (`lucid.app`), one viewer, and it's the only frameable path. `invitationId` carries share-link access, which the FAQ says embeds honour **[assumption]**.
5. **Lazy loading:** an `IntersectionObserver` with `rootMargin: "400px 0px"` sets the iframe `src` the first time the card nears the viewport. Once loaded it stays loaded. Its DOM is kept across re-renders by giving the widget a stable `key` (`lucid:<uuid>:<pos-independent index>`, see §6.3). *Why:* documents with many diagrams don't open many Lucid sessions at once, and typing doesn't reload frames.
6. **Edit target:** with `kenMarkdown.lucidchart.editWith: "auto"` (default), Edit opens in Lucid for VS Code if `vscode.extensions.getExtension("LucidSoftware.lucidforvscode")` exists. Otherwise it opens the browser. *Why:* it is the only way to edit *inside VS Code* (the user's "click Edit to edit them"), and it is Lucid's supported product. The browser is the universal fallback.
7. **Edit URL:** `https://lucid.app/lucidchart/<uuid>/edit`, keeping `invitationId`. When the link in the document is already an `/edit` or `/view` URL on `lucid.app`, it is used exactly as written, so `?page=`, `viewport_loc` and invitation are preserved. *Why:* both targets accept this shape. Legacy hosts redirect, but normalizing avoids depending on that.
8. **Reload after editing:** after Edit or Open, the card is marked `pending`. On the next `window` `focus` or `visibilitychange` to visible, pending frames reload (`src` reassigned) and pending published images get a cache-busting `?v=<time>` in the DOM only, the way `drawio.ts` `refreshImages` does it. There is also a manual **Reload** button. *Why:* Lucid's viewer shows the latest version on load, but a live frame doesn't push updates to us.
9. **The host validates every URL.** The webview sends `{type: "openLucid", url, action}`, and the host re-parses it with the same pure parser. It refuses anything that isn't an allowlisted Lucid URL and never opens a URL built by the webview. *Why:* the webview renders untrusted documents.
10. **Message-origin guard** in `main.ts` (WP3): ignore `message` events whose `origin !== window.origin` or whose `source` is not `window.parent` or `window`. *Why:* §3.5. This is a pre-existing hole, and persistent third-party frames make it real.
11. **Link-form fidelity (WP1):** the `link` mark gets a `form` attribute (`"literal" | "autolink" | "inline"`) set at parse time from the source text. The serializer writes the same form back when it is still safe. *Why:* §3.6, round-trip goal 3. It is a general fix and also a prerequisite.
12. **Settings:** `kenMarkdown.lucidchart.preview` (`"auto"` | `"onClick"` | `"off"`, default `"auto"`) and `kenMarkdown.lucidchart.editWith` (`"auto"` | `"browser"`, default `"auto"`). *Why:* the user can avoid network calls to Lucid (privacy, slow links) and pick an editor. Nothing about embeds is stored in the file.
13. **Lucidchart only by default.** `/lucidspark/…` URLs are parsed (so the parser is complete and the handoff accepts them) but not previewed unless Q3 says otherwise.

## 5. Markdown syntax

All of these stay exactly as written. Nothing is added to the file.

```markdown
https://lucid.app/lucidchart/3f2a…-…/edit
```
A bare link on its own line: preview (embedded viewer).

```markdown
<https://lucid.app/lucidchart/3f2a…/edit>
[Payments architecture](https://lucid.app/lucidchart/3f2a…/edit)
https://lucid.app/documents/embedded/3f2a…
https://www.lucidchart.com/documents/view/3f2a…
```
Also a preview. The second line's card title is "Payments architecture".

```markdown
[![Payments architecture](https://lucid.app/publicSegments/view/9c1e…/image.png)](https://lucid.app/lucidchart/3f2a…/edit)
```
**Recommended for repositories.** The published image shows here and on GitHub, and the toolbar edits the linked document.

```markdown
See the [payments diagram](https://lucid.app/lucidchart/3f2a…/edit) for details.
```
Stays a link. A click opens the browser, as now.

On GitHub, the first four forms show as plain links and the image form as a clickable image.

## 6. Architecture

### 6.1 Files

| File | New/changed | Purpose |
| --- | --- | --- |
| `src/lucidUrl.ts` | new, pure (no `vscode`) | `parseLucidUrl(href) → LucidRef \| null`, `embedUrl(ref)`, `editUrl(ref, original)`, `lucidExtensionUri(scheme, url)`. Imported by host and webview |
| `webview/markdown/linkFidelity.ts` | new | remark plugin + `link` mark extension for `form` (WP1) |
| `webview/markdown/lucid.ts` | new | ProseMirror plugin: find candidate paragraphs, widget decorations, card DOM, lazy load, reload, actions |
| `webview/styles.css` | changed | `.ken-lucid-*` styles, `--vscode-*` only |
| `webview/editorSetup.ts` | changed | `EditorOptions.lucid?: LucidOptions`; `crepe.editor.use(lucidPlugin(options.lucid))` after `wikiLinkPlugin`; `use(linkFidelity)` |
| `webview/main.ts` | changed | origin guard (WP3); pass `lucid` options (config + `post` for actions); rebuild decorations on `config` |
| `src/protocol.ts` | changed | `EditorConfig.lucidchart`, `WebviewMessage` `openLucid` |
| `src/provider.ts` | changed | CSP `frame-src`; `readConfig`; `openLucid` handler |
| `package.json` | changed | two settings |
| `test/unit/lucidUrl.test.ts`, `test/unit/lucid.test.ts`, `test/unit/gfm.test.ts` | new/changed | §10 |
| `test/integration/suite/editor.test.ts`, `test/fixtures/lucid.md` | changed/new | §10 |
| `harness/check-lucid.mjs` | new | §10 |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md` | changed | §12 |

### 6.2 URL parser (`src/lucidUrl.ts`)

```ts
export type LucidProduct = "lucidchart" | "lucidspark" | "unknown";
export type LucidRef =
  | { kind: "document"; id: string; product: LucidProduct; invitationId?: string; href: string }
  | { kind: "image"; publicId: string; href: string };

export const LUCID_HOSTS = ["lucid.app", "www.lucidchart.com", "lucidchart.com", "app.lucidchart.com"];
export function parseLucidUrl(href: string): LucidRef | null;
export function embedUrl(ref: LucidRef & { kind: "document" }): string;      // https://lucid.app/documents/embedded/<id>[?invitationId=…]
export function editUrl(ref: LucidRef & { kind: "document" }): string;       // §4 decision 7
export function lucidExtensionUri(uriScheme: string, docUrl: string): string; // `${scheme}://LucidSoftware.lucidforvscode/open-document?url=${encodeURIComponent(docUrl)}`
```

Rules:

- `new URL(href)` must succeed. The protocol must be `https:`, with no username or password and no port (or `443`). The hostname must lower-case-equal one of `LUCID_HOSTS`, so `lucid.app.evil.com` and `evil.com/lucid.app` are rejected.
- The ID must match `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. This is what Lucid's own extension requires. It is lower-cased for keys.
- Document paths:
  - `/{lucidchart|lucidspark}/<id>/{edit|view|comment}`;
  - `/documents/{edit|view|comment|embedded|embeddedchart}/<id>[/…]` (product `unknown` for `/documents/…`, which is previewed as Lucidchart);
  - a trailing slash or extra segments after the ID are tolerated.
- The image path is `/publicSegments/view/<id>/image.png` on `lucid.app` only.
- Everything else returns `null`. That includes `/invitations/accept/…`, `/folder/…`, `/users/…`, `/lucidscale/…` and `publicSegments` without `image.png`, all of which stay plain links.

### 6.3 Webview plugin (`webview/markdown/lucid.ts`)

```ts
export interface LucidOptions {
  mode: () => "auto" | "onClick" | "off";
  editWith: () => "auto" | "browser";         // label only; the host decides
  open: (url: string, action: "edit" | "open") => void;   // posts openLucid
}
export function lucidPlugin(options?: LucidOptions): MilkdownPlugin;
export function findLucidBlocks(doc: ProseNode): LucidBlock[]; // pure, unit-tested
export const lucidRefreshKey: PluginKey; // meta to rebuild after a config change
```

- **State:** `PluginState { blocks: LucidBlock[]; decorations: DecorationSet }`. It is recomputed in `apply` only when `tr.docChanged` or `tr.getMeta(lucidRefreshKey)`. `findLucidBlocks` walks only textblocks that are direct children of `doc`, `list_item`, `blockquote` or `github_alert` (not table cells), so the work stays linear in the number of blocks.
- **`LucidBlock`:** `{ pos, end, ref, title, form: "frame" | "image" }`. `pos` is the paragraph start. The widget goes at `end` (after the paragraph) with `side: 1`, `ignoreSelection: true` and `stopEvent: () => true`, so clicks and keys inside the card never reach ProseMirror.
- **Widget key:** `lucid:<id>:<n>`, where `n` counts earlier blocks with the same ID. The key doesn't change as text above it changes, so ProseMirror reuses the DOM and the iframe is not reloaded.
- **Source line:** `Decoration.node(pos, end, { class: "ken-lucid-source" })` on the paragraph styles the link as a small muted caption above the card. It stays fully editable text.
- **Card DOM** (`contenteditable="false"`, `role="group"`, `aria-label="Lucidchart diagram: <title>"`):
  - header: Lucid-neutral icon (Lucide `Workflow`) + title (link text, the image alt, or "Lucidchart diagram") + buttons **Edit**, **Open in Lucidchart**, **Reload** (Lucide `Pencil`, `ExternalLink`, `RotateCw`; 13 px, as the drawio button).
  - body:
    - for `frame`: `<iframe class="ken-lucid-frame" title="<title> (Lucidchart)" sandbox="allow-scripts allow-same-origin" referrerpolicy="strict-origin" loading="lazy" allow="" data-src="<embedUrl>">`, with `src` set lazily. `allow-same-origin` lets the viewer use its own `lucid.app` storage. It does **not** give the frame our origin.
    - for `image`: no body; the toolbar is attached as a sibling *after* the existing inline image paragraph.
  - footer hint (frame form only): see §8.
- **Fallback states** (replace the body, keep the header): `offline`, `timeout` and `onClick` (§8). The timeout starts when `src` is set. If the iframe `load` event hasn't fired within 20 s, the timeout card shows. A later `load` restores the frame.
- **Offline:** if `navigator.onLine === false` when the card would load, show the offline card and listen for `online`, then load.
- **Actions:**
  - Edit: `open(ref.href, "edit")`.
  - Open: `open(ref.href, "open")`.
  - Both set `pending = true`, so the frame or image reloads on the next `focus` or `visibilitychange`.
  - Reload: reassign `src`.
  - For images, Reload sets the DOM `img.src` to `<src>?v=<Date.now()>`. The doc attribute is never touched.
- **No transactions.** The plugin never calls `dispatch`, except the read-only refresh meta from main.ts on config change, which changes no document content. It never mutates the doc, so `isRemoteChange` doesn't apply. Remote edits that add or remove Lucid links update the widgets through the same `apply` path.
- **`mode() === "off"`:** no decorations at all.

### 6.4 Host (`src/provider.ts`)

- **CSP:** `"frame-src https://embed.diagrams.net https://lucid.app"`, with a comment. It is static, because the setting is enforced in the webview and changing the CSP needs a webview reload. Redirects within `lucid.app` are covered. Legacy hosts are never framed, because of normalization.
- **`readConfig`:** `lucidchart: { preview: c.get("lucidchart.preview", "auto"), editWith: c.get("lucidchart.editWith", "auto") }`. `onDidChangeConfiguration` already re-posts `config`.
- **`case "openLucid"`:**
  1. `const ref = parseLucidUrl(m.url)`. If it is null, return silently.
  2. `action === "open"`, or `ref.kind === "image"`: `openExternal(ref.kind === "image" ? ref.href : editUrl(ref))`. For "open" it uses the document link exactly as written when it is a view or edit URL.
  3. `action === "edit"`: if `editWith === "auto"` and `vscode.extensions.getExtension("LucidSoftware.lucidforvscode")` is defined, `openExternal(Uri.parse(lucidExtensionUri(vscode.env.uriScheme, editUrl(ref))))`. If that returns `false` or throws, fall back to the browser. Otherwise open the browser with `editUrl(ref)`.

  **Spike item (WP0):** confirm that `openExternal` with a `vscode://` URI goes to the installed extension's URI handler without a confirmation prompt. If there is a prompt, use `vscode.commands.executeCommand("vscode.open", uri)` or accept it.

### 6.5 Data flow

```
Markdown ──parse──▶ PM doc (paragraph > text[link])          (unchanged; WP1 adds link.form)
                        │
          lucid plugin apply(): findLucidBlocks ──▶ widget decorations (no doc change)
                        │
   card visible ─▶ iframe.src = https://lucid.app/documents/embedded/<id>   (CSP frame-src)
                        │
   Edit click ─▶ post {type:"openLucid", url, action:"edit"} ─▶ host parseLucidUrl
                        ├─ Lucid for VS Code installed → vscode://LucidSoftware.lucidforvscode/open-document?url=…
                        └─ else → openExternal(https://lucid.app/lucidchart/<id>/edit)
   window focus ─▶ pending cards reload
```

## 7. Protocol changes (`src/protocol.ts`)

```ts
export interface EditorConfig {
  // …existing
  lucidchart: {
    preview: "auto" | "onClick" | "off";
    editWith: "auto" | "browser";
    /** Lucid for VS Code is installed (Edit tooltip only; the host decides at click time). */
    lucidExtension: boolean;
  };
}

export type WebviewMessage =
  // …existing
  | { type: "openLucid"; url: string; action: "edit" | "open" };
```

The harness `init` message in `harness/harness.mjs` must add `lucidchart` to its `config`. The webview treats a missing `lucidchart` as `{ preview: "auto", editWith: "auto" }`, so old harness themes keep working.

## 8. UI and copy (exact strings)

- Card title fallback: `Lucidchart diagram`
- Buttons: `Edit`, `Open in Lucidchart`, `Reload`
- Edit tooltip: `Edit in Lucid for VS Code` when the host reported the extension, otherwise `Edit in your browser`. To support this, the host adds `lucidExtension: boolean` to the `lucidchart` config. It is computed in `readConfig` from `vscode.extensions.getExtension` and refreshed on `vscode.extensions.onDidChange`.
- Footer hint under every frame:
  `Blank, or asking you to sign in? The owner can turn on More › Embed › Activate Embed Code in Lucid, or publish it as an image and link that here.`
  The final words "publish it as an image" link to the help article `https://help.lucid.co/hc/en-us/articles/16181914460692`, opened through `openLink`.
- `onClick` mode card: `Lucidchart preview` / button `Load preview` / small text `Loads from lucid.app.`
- Offline card: `You're offline. The preview loads when you're back online.`
- Timeout card: `Lucidchart could not be reached.` + buttons `Try again`, `Open in Lucidchart`
- Bare published image without a document link: toolbar shows only `Open image`.

**Styling** (all colours and fonts from `--vscode-*`):

- Card: `border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border))`; header background `var(--vscode-editorWidget-background)`; text `var(--vscode-foreground)`; hint `var(--vscode-descriptionForeground)`.
- Buttons: copy the existing `.ken-drawio-edit` button styles (`--vscode-button-secondaryBackground` and so on).
- Frame: `width: 100%`, `aspect-ratio: 4 / 3` (Lucid's default 640×480 embed), `min-height: 240px`, `max-height: 70vh`, `border: 0`. The body background `var(--vscode-editor-background)` is shown while loading.
- Focus rings: `var(--vscode-focusBorder)`.
- Selected state: when the selection covers the source paragraph, the card gets `outline: 1px solid var(--vscode-focusBorder)` through the node decoration class, so the user can see that deleting the line deletes the preview.

## 9. Security, privacy, failure and collab

**Security**

- Hosts are allowlisted twice. The webview previews only what `parseLucidUrl` accepts, and the CSP `frame-src` admits only `https://lucid.app`, so even a bug in the webview can't frame anything else.
- The host re-validates before any `openExternal`.
- The sandbox is `allow-scripts allow-same-origin` only: no forms, popups, top navigation, downloads or modals. VS Code's own sandbox already denies popups and top navigation (§3.2).
- The WP3 origin guard stops frames from posting forged host messages.
- No `vscode` API, file access or document text is reachable from the frame: it is cross-origin.
- `referrerpolicy="strict-origin"` sends at most the webview origin (random per webview), never the document path. If WP0 shows the embedded viewer works without a referrer, switch to `no-referrer`.

**Privacy**

- In `auto` mode, opening a document makes requests to `lucid.app` for each visible Lucid link. Lucid sees the document ID and the user's IP. Images on `https:` already behave this way in this editor.
- `onClick` and `off` avoid it.
- The README FAQ "Does it need an internet connection?" must mention Lucid previews.

**Offline and failure**

- Offline: the offline card, then an automatic load on `online`.
- Lucid unreachable or a DNS failure: the 20 s timeout card. Chromium's own error page may appear inside the frame before that.
- Doc not shared or not activated: Lucid's in-frame message, plus our permanent hint.
- Lucid for VS Code missing or failing: the browser.

**Resume**

- Nothing persists. Reopening the document rebuilds the cards.
- An Edit started in another app has no state here. The reload on focus picks up its result.
- A webview reload (VS Code restarts the webview when hidden for long) re-creates the cards, lazily.

**Collaboration**

- Decorations are per-client.
- Peers with the setting `off` see links.
- The `link.form` attribute from WP1 syncs through Y.js like other mark attributes. A peer on an older version drops the unknown attribute, which can only cause the old `<url>` normalization on that peer's write. That is acceptable.
- No `appendTransaction`, so `remoteChange.ts` has nothing to guard.

## 10. Test plan

**Unit (vitest, happy-dom, `test/unit/editorEnv.ts`)**

- `lucidUrl.test.ts`: a table of accepted shapes, one per row of §3.1, legacy hosts, trailing slash, `?invitationId`, `#page`, upper-case IDs. Rejected:
  - `http:`;
  - `lucid.app.evil.com`;
  - `user@lucid.app`;
  - `:8443`;
  - non-UUID IDs;
  - `/invitations/accept/inv_x`;
  - `/lucidscale/…`;
  - `javascript:`;
  - `data:`.

  Also covers `embedUrl` and `editUrl` outputs, and `lucidExtensionUri` encoding, compared against the exact string the Lucid extension's `Vi()` decodes.
- `lucid.test.ts` (`mountEditor`, stubbing `IntersectionObserver` to fire immediately):
  - bare, `<…>`, `[t](…)` and `embedded` links alone in a paragraph produce one `.ken-lucid-card` with `iframe[data-src="https://lucid.app/documents/embedded/<id>"]` and `sandbox="allow-scripts allow-same-origin"`;
  - the `[t](…)` card title is `t`;
  - inline links, two links in one paragraph, links in table cells and non-Lucid links produce none;
  - the image form produces a toolbar with Edit and no iframe;
  - typing elsewhere keeps the same iframe element (`===`), so the key is stable;
  - deleting the paragraph removes the card;
  - the plugin dispatches no transactions (spy on `view.dispatch` during mount and config refresh), and `doc.eq` holds before and after;
  - `mode: "off"` produces no cards;
  - `onClick` shows `Load preview` and sets `src` only after a click;
  - Edit and Open call `options.open` with the original href and action;
  - a remote-style transaction (`y-sync$` meta) updates cards the same way.
- `gfm.test.ts` (WP1), round-trip cases that must survive unchanged:
  - a bare literal alone;
  - a literal mid-sentence;
  - `www.example.com`;
  - `mail@example.com`;
  - `<https://…>`;
  - `[https://x](https://x)`;
  - a literal followed by `.`, `,` or `)`.

  A literal with typed text right after it falls back to `<url>`. Plus "an unrelated edit keeps the link form": mount, insert text in another paragraph, serialize, and check that only that paragraph differs.
- `main.ts` origin guard: extract `isHostMessage(event, win)` into a small pure module (`webview/hostMessage.ts`) and unit-test that same-origin parent and self messages pass and cross-origin child messages fail.

**Integration (`npm run test:integration`, real VS Code)**

- Fixture `test/fixtures/lucid.md` with each form. Use `count` on `.ken-lucid-card` and `getAttr` on the iframe `data-src` and `sandbox`.
- Opening the file leaves `doc.isDirty === false`.
- Type in another paragraph and assert that the Lucid lines are byte-identical.
- Change `kenMarkdown.lucidchart.preview` to `off`: the cards disappear and nothing is written.
- Edit click: add a host test seam (a `lastExternal` recorded by `openLucid` when `process.env.KEN_TEST` is set, following whatever pattern the suite uses for `openLink`) and assert the browser URL. The Lucid extension isn't installed in the test VS Code, so the browser path is the one tested.
- The CSP string contains `frame-src https://embed.diagrams.net https://lucid.app`.

**Harness (`harness/check-lucid.mjs`, Playwright and Chromium against `dist/webview`)**

- Load the fixture.
- Check that a public published PNG (constant at the top, documented as third-party and liable to disappear) loads (`naturalWidth > 0`).
- Check that a public embedded doc frame reaches `load`.
- Screenshot in light and dark themes for visual review.
- Assert that injecting an `<iframe src="https://example.com">` is blocked by CSP (a `securitypolicyviolation` event).
- Assert that a cross-origin `postMessage({type:"update"…})` from the Lucid frame is ignored (WP3).

**Crash and resume (manual, in WP0 and WP6)**

- Reload the window while previews are loading: no writes, and the cards come back.
- Go offline and back online.
- Click Edit, edit in the browser, return to VS Code: the frame reloads and shows the change.

## 11. Work packages (dependency order)

| WP | Title | Owner area / files | Depends on | Targeted tests |
| --- | --- | --- | --- | --- |
| **WP0** | **Spike in real VS Code** (no merge; findings appended to this spec) | scratch extension or a local patch, never merged | none | Manual: (1) does `/documents/embedded/<public id>` render inside a Ken webview with no Lucid sign-in? (2) What does a non-activated doc show, and does the frame `postMessage` anything (log `message` events with `source` not equal to the parent)? (3) Does it need a referrer? (4) Does `openExternal(vscode://LucidSoftware.lucidforvscode/open-document?url=…)` open the doc in Lucid for VS Code, and with what prompt? (5) Does `?page=` or `/<page>` select a page in the embedded viewer? |
| **WP1** | Link-form fidelity | `webview/markdown/linkFidelity.ts` (new), `webview/editorSetup.ts` (one `use` line), `test/unit/gfm.test.ts` | none | `npx vitest run test/unit/gfm.test.ts` |
| **WP2** | Lucid URL parser | `src/lucidUrl.ts`, `test/unit/lucidUrl.test.ts` | none | `npx vitest run test/unit/lucidUrl.test.ts` |
| **WP3** | Host-message origin guard | `webview/hostMessage.ts` (new), `webview/main.ts` (listener only), test | none | `npx vitest run test/unit/hostMessage.test.ts`; `node harness/check-editing.mjs` (harness posts same-window messages; must still pass) |
| **WP4** | Host side: settings, CSP, `openLucid` | `src/protocol.ts`, `src/provider.ts`, `package.json` (settings only) | WP2 | `npm run typecheck`; `npx vitest run test/unit/lucidUrl.test.ts` |
| **WP5** | Webview embed plugin and styles | `webview/markdown/lucid.ts`, `webview/styles.css` (`.ken-lucid-*` block only), `webview/editorSetup.ts` (options + `use`), `webview/main.ts` (wire options, refresh on `config`), `test/unit/lucid.test.ts` | WP2; protocol shape from §7 (codes against it; rebase onto WP4) | `npx vitest run test/unit/lucid.test.ts`; `npm run typecheck` |
| **WP6** | Integration, harness, docs | `test/integration/suite/editor.test.ts`, `test/fixtures/lucid.md`, `harness/check-lucid.mjs`, `harness/harness.mjs` (config), `README.md`, `CHANGELOG.md`, `CLAUDE.md` | WP1, WP3, WP4, WP5 | `node harness/check-lucid.mjs <theme>` (builder may run this one harness); integration runs are for the tester |

**Parallelism:** WP0, WP1, WP2 and WP3 can run at once. WP4 and WP5 run in parallel after WP2. WP6 comes last. Long tests for the tester after merge are the full `npm test`, `npm run test:integration`, and `harness/check-lucid.mjs` plus `check-editing.mjs` across the dumped themes.

**Shared-file conflicts:**

- `webview/editorSetup.ts`: WP1 and WP5 each add one line; trivial merge.
- `webview/main.ts`: WP3 changes the listener and WP5 the editor options; different regions.
- `src/protocol.ts`: owned by WP4.

**WP1 implementation notes** (for the builder):

- `$remark("kenLinkForm", () => (tree, file) => …)`. Milkdown calls `remark.runSync(remark.parse(md), md)`, so `String(file)` is the source **[verified, `@milkdown/transformer` `lib/index.js` line ~160]**. For each mdast `link`, look at `source[position.start.offset]`: `<` gives `autolink`, `[` gives `inline`, anything else `literal`. Store it as `node.data.kenForm`.
- Extend `linkSchema` (`@milkdown/kit/preset/commonmark`) with an attribute `form` (default `"inline"`). Parse it from `node.data?.kenForm`. On serialize, pass it to the mdast node.
- Add a `toMarkdownExtensions` handler for `link`. When `form === "literal"`, the node's text content equals the URL as written (for `www.` literals: `"http://" + text === url`; for email literals: `"mailto:" + text === url`), and `info.after` is empty, whitespace or one of `.,:;!?` and `info.before` is empty, whitespace, `(`, `*`, `_` or `~`, return the text unescaped. When `form === "inline"`, force `[text](url)` even if text equals url. Otherwise delegate to the default handler (`defaultHandlers.link` from `mdast-util-to-markdown`, which needs adding as a direct dependency if it isn't one already).
- Underline, comment markers and math already extend `toMarkdownExtensions` the same way (`underline.ts`, `mathSyntax.ts`), so follow them.

## 12. Rollout and user steps

- Ship behind the default `preview: "auto"`. There are no migrations and nothing is stored.
- `CHANGELOG.md` `## [Unreleased]`:
  - **Added:** "Lucidchart links on their own line show a live preview, with Edit (in Lucid for VS Code when installed, otherwise your browser) and Open buttons. Linked published images get the same buttons. Set `kenMarkdown.lucidchart.preview` to `onClick` or `off` to load nothing from Lucid until you ask."
  - **Fixed:** "Bare links (`https://…`) and `[url](url)` links are no longer rewritten as `<https://…>` when you edit elsewhere in the document."
- README:
  - add a Lucidchart bullet beside draw.io;
  - update the internet-connection FAQ;
  - document the recommended published-image form and the "Activate Embed Code" requirement.
- CLAUDE.md: add a **Lucidchart** architecture bullet covering decorations, no doc mutation, the `lucidUrl.ts` allowlist, the frame-src host and the origin guard.
- **The user has to do these in Lucid** (documented, not automated):
  - activate the embed code per document for anonymous previews (More › Embed › Activate Embed Code), or publish as an image (More › Publish › Image) and use the image-link form;
  - optionally install **Lucid for VS Code** and run **Lucid: Sign in** to edit inside VS Code.
- No keys, deploys or Lucid developer registration are needed for v1.

## 13. Open questions (for the user)

1. **Default preview mode.** `auto` (load when scrolled into view) / `onClick` (a card with "Load preview") / `off`. *Recommendation: `auto`.* You asked for previews, and remote images already load this way.
2. **Where Edit goes.** `auto` (Lucid for VS Code if installed, else browser) / always the browser. *Recommendation: `auto`.* It is the only way to edit inside VS Code. It relies on an undocumented URI handler in Lucid's extension, with a browser fallback.
3. **Lucidspark boards.** Preview them like Lucidchart / leave them as plain links. *Recommendation: preview them too.* The embedded viewer and Lucid's extension handle both, so it costs one condition. The spec defaults to Lucidchart-only until you say.
4. **Signed-in previews of private docs (later phase).** Build token-based embeds with a Ken Lucid developer app (OAuth sign-in in VS Code, SecretStorage, `POST /embeds/token`), so any doc you can access previews without activating its embed code / don't. *Recommendation: not now.* It needs a registered Lucid app and Lucid's confirmation that public clients are supported. Revisit if WP0 shows activated embeds are too limiting.
5. **Fix bare-link rewriting for all links (WP1), not only Lucid ones.** Yes / Lucid links only / no. *Recommendation: yes for all.* It is the same code, and it removes surprise diffs (`https://…` becoming `<https://…>`) everywhere.
6. **Should the source link line stay visible above the preview?** Visible as a muted caption / hidden until the caret enters it. *Recommendation: visible.* It keeps the link editable and discoverable, and hiding text that is in the file confuses selection and deletion.
