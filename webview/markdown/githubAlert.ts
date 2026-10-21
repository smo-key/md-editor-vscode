/**
 * GitHub alerts (`> [!NOTE]`, `> [!TIP]`, …) for the Milkdown editor.
 *
 * The bundle is self-contained: a remark plugin owns both directions of the
 * markdown conversion (mdast transform on the way in, a `toMarkdown` handler on
 * the way out), a node schema owns the ProseMirror side, and a command plus a
 * menu-group helper provide the insertion affordances.
 *
 * Use it as `crepe.editor.use(githubAlertPlugins)`.
 */
import type { Ctx, MilkdownPlugin } from "@milkdown/kit/ctx";
import type { NodeType, Node as ProseNode } from "@milkdown/kit/prose/model";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import { commandsCtx } from "@milkdown/kit/core";
import { wrapIn } from "@milkdown/kit/prose/commands";
import { TextSelection } from "@milkdown/kit/prose/state";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import { $command, $nodeSchema, $remark } from "@milkdown/kit/utils";

/** The five alert kinds GitHub understands, lower-cased. */
export type GithubAlertKind =
  | "note"
  | "tip"
  | "important"
  | "warning"
  | "caution";

export interface GithubAlertKindInfo {
  kind: GithubAlertKind;
  /** Title shown in the banner, e.g. "Note". */
  label: string;
  /** Inline SVG markup for the banner icon. */
  icon: string;
}

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** The alert kinds, in GitHub's documented order. */
export const githubAlertKinds: readonly GithubAlertKindInfo[] = [
  {
    kind: "note",
    label: "Note",
    icon: icon(
      '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    ),
  },
  {
    kind: "tip",
    label: "Tip",
    icon: icon(
      '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8a6 6 0 0 0-12 0c0 1.22.5 2.54 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>',
    ),
  },
  {
    kind: "important",
    label: "Important",
    icon: icon(
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4"/><path d="M12 14h.01"/>',
    ),
  },
  {
    kind: "warning",
    label: "Warning",
    icon: icon(
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    ),
  },
  {
    kind: "caution",
    label: "Caution",
    icon: icon(
      '<path d="m4.93 4.93 14.14 14.14"/><circle cx="12" cy="12" r="10"/>',
    ),
  },
];

const kindByName = new Map<string, GithubAlertKindInfo>(
  githubAlertKinds.map((k) => [k.kind, k]),
);

/** Coerce any string to a known alert kind, defaulting to `note`. */
export function normalizeGithubAlertKind(value: unknown): GithubAlertKind {
  const name = String(value ?? "").toLowerCase();
  return kindByName.has(name) ? (name as GithubAlertKind) : "note";
}

// ---------------------------------------------------------------------------
// remark: mdast transform (markdown -> githubAlert) and toMarkdown handler.
// ---------------------------------------------------------------------------

/** The mdast node type this plugin introduces. */
export const GITHUB_ALERT_MDAST_TYPE = "githubAlert";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

const MARKER_RE = /^\[!(note|tip|important|warning|caution)\][^\S\r\n]*/i;

/**
 * Convert a blockquote into a `githubAlert` node when its first paragraph
 * starts with an alert marker. Returns `null` for plain blockquotes.
 */
function blockquoteToAlert(node: MdastNode): MdastNode | null {
  const children = node.children;
  const first = children?.[0];
  if (!children || !first || first.type !== "paragraph") return null;

  const inline = first.children?.[0];
  if (!inline || inline.type !== "text" || typeof inline.value !== "string")
    return null;

  const match = MARKER_RE.exec(inline.value);
  if (!match) return null;

  const kind = normalizeGithubAlertKind(match[1]);
  let rest = inline.value.slice(match[0].length);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);

  const body = children.slice(1);
  if (rest.length > 0) {
    inline.value = rest;
    body.unshift(first);
  } else {
    const remaining = (first.children ?? []).slice(1);
    // A hard break directly after the marker belonged to the marker line.
    if (remaining[0]?.type === "break") remaining.shift();
    if (remaining.length > 0) {
      first.children = remaining;
      body.unshift(first);
    }
  }

  return { type: GITHUB_ALERT_MDAST_TYPE, kind, children: body };
}

function transformTree(node: MdastNode): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    transformTree(child);
    if (child.type === "blockquote") {
      const alert = blockquoteToAlert(child);
      if (alert) children[i] = alert;
    }
  }
}

// mdast-util-to-markdown's `State`, narrowed to what the handler needs. The
// real types are not re-exported by @milkdown/kit, so describe them locally.
interface ToMarkdownState {
  enter: (name: string) => () => void;
  createTracker: (info: unknown) => {
    move: (value: string) => string;
    shift: (n: number) => void;
    current: () => unknown;
  };
  containerFlow: (node: unknown, info: unknown) => string;
  indentLines: (
    value: string,
    map: (line: string, index: number, blank: boolean) => string,
  ) => string;
}

const indentBlockquote = (line: string, _index: number, blank: boolean) =>
  ">" + (blank ? "" : " ") + line;

/**
 * Serialize `githubAlert` back to `> [!KIND]` + the children as a blockquote.
 *
 * When the first child is a paragraph the marker shares the blockquote with it
 * (`> [!NOTE]\n> text`), matching GitHub's canonical form and making the common
 * case round trip byte for byte. Otherwise a blank quote line separates the
 * marker from the first block so it cannot be swallowed by it.
 */
function alertToMarkdown(
  node: MdastNode,
  _parent: unknown,
  state: ToMarkdownState,
  info: unknown,
): string {
  const exit = state.enter("blockquote");
  const tracker = state.createTracker(info);
  tracker.move("> ");
  tracker.shift(2);
  const body = node.children?.length
    ? state.containerFlow(node, tracker.current())
    : "";
  const marker = `[!${normalizeGithubAlertKind(node.kind).toUpperCase()}]`;
  const separator = !body
    ? ""
    : node.children?.[0]?.type === "paragraph"
      ? "\n"
      : "\n\n";
  const value = state.indentLines(marker + separator + body, indentBlockquote);
  exit();
  return value;
}

interface RemarkProcessor {
  data: () => Record<string, unknown>;
}

function remarkGithubAlert(this: RemarkProcessor) {
  const data = this.data();
  const extensions = (data.toMarkdownExtensions ??= []) as unknown[];
  extensions.push({ handlers: { [GITHUB_ALERT_MDAST_TYPE]: alertToMarkdown } });
  return (tree: MdastNode) => {
    transformTree(tree);
  };
}

/** The remark plugin handling both markdown directions. */
export const remarkGithubAlertPlugin = $remark(
  "githubAlert",
  () => remarkGithubAlert as never,
);

// ---------------------------------------------------------------------------
// ProseMirror node schema
// ---------------------------------------------------------------------------

function renderAlert(node: ProseNode) {
  const kind = normalizeGithubAlertKind(node.attrs.kind);
  const info = kindByName.get(kind) ?? githubAlertKinds[0]!;

  const dom = document.createElement("div");
  dom.className = "github-alert";
  dom.setAttribute("data-kind", kind);

  const title = document.createElement("div");
  title.className = "github-alert-title";
  title.setAttribute("contenteditable", "false");
  title.setAttribute("draggable", "false");
  const iconSpan = document.createElement("span");
  iconSpan.className = "github-alert-icon";
  iconSpan.innerHTML = info.icon;
  const label = document.createElement("span");
  label.textContent = info.label;
  title.append(iconSpan, label);

  const contentDOM = document.createElement("div");
  contentDOM.className = "github-alert-body";

  dom.append(title, contentDOM);
  return { dom, contentDOM };
}

/** Schema for the `github_alert` block node. */
export const githubAlertSchema = $nodeSchema("github_alert", () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: { kind: { default: "note" as string } },
  parseDOM: [
    {
      tag: "div.github-alert",
      contentElement: ".github-alert-body",
      getAttrs: (dom: HTMLElement | string) => ({
        kind: normalizeGithubAlertKind(
          typeof dom === "string" ? dom : dom.getAttribute("data-kind"),
        ),
      }),
    },
  ],
  toDOM: (node: ProseNode) => renderAlert(node),
  parseMarkdown: {
    match: ({ type }: MarkdownNode) => type === GITHUB_ALERT_MDAST_TYPE,
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.openNode(type, { kind: normalizeGithubAlertKind(node.kind) });
      state.next(node.children ?? []);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "github_alert",
    runner: (state: SerializerState, node: ProseNode) => {
      state.openNode(GITHUB_ALERT_MDAST_TYPE, undefined, {
        kind: normalizeGithubAlertKind(node.attrs.kind),
      });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

// ---------------------------------------------------------------------------
// Commands and menu wiring
// ---------------------------------------------------------------------------

/**
 * Turn the current block into an alert of the given kind: an empty block is
 * replaced outright, a block with content is wrapped.
 */
export const insertGithubAlertCommand = $command<
  GithubAlertKind,
  "InsertGithubAlert"
>("InsertGithubAlert", (ctx) => (payload) => (state, dispatch) => {
  const kind = normalizeGithubAlertKind(payload);
  const type = githubAlertSchema.type(ctx);
  const { $from } = state.selection;
  const parent = $from.parent;

  if (parent.isTextblock && parent.content.size === 0 && $from.depth >= 1) {
    const node = type.createAndFill({ kind });
    if (!node) return false;
    if (dispatch) {
      const from = $from.before($from.depth);
      const to = $from.after($from.depth);
      const tr = state.tr.replaceRangeWith(from, to, node);
      const selection = TextSelection.near(tr.doc.resolve(from + 1));
      dispatch(tr.setSelection(selection).scrollIntoView());
    }
    return true;
  }

  return wrapIn(type, { kind })(state, dispatch);
});

/** Everything the editor needs for GitHub alerts, ready for `editor.use(...)`. */
export const githubAlertPlugins: MilkdownPlugin[] = [
  remarkGithubAlertPlugin,
  githubAlertSchema,
  insertGithubAlertCommand,
].flat() as MilkdownPlugin[];

/** Structural shape of Crepe's `GroupBuilder`, so we need no Crepe import. */
export interface AlertGroupBuilder {
  addGroup: (
    key: string,
    label: string,
  ) => {
    addItem: (
      key: string,
      item: { label: string; icon: string; onRun?: (ctx: Ctx) => void },
    ) => unknown;
  };
}

/**
 * Register an "Alerts" group with the five alert items on a Crepe slash /
 * block-edit menu builder.
 */
export function addGithubAlertMenuGroup(
  builder: AlertGroupBuilder,
  label = "Alerts",
): void {
  const group = builder.addGroup("alerts", label);
  for (const info of githubAlertKinds) {
    group.addItem(info.kind, {
      label: info.label,
      icon: info.icon,
      onRun: (ctx: Ctx) => {
        const commands = ctx.get(commandsCtx);
        commands.call(clearTextInCurrentBlockCommand.key);
        commands.call(insertGithubAlertCommand.key, info.kind);
      },
    });
  }
}
