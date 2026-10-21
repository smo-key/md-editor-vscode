/**
 * Drag handles, for checklist items only: hovering a task shows a grip to its
 * left that drags it (and its sub-items) to a new place. No other block gets
 * a handle, and there is no "+" button; the slash menu and the bottom toolbar
 * insert blocks instead.
 */
import type { Editor } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { block, blockConfig, BlockProvider } from "@milkdown/kit/plugin/block";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { createElement, GripVertical } from "lucide";

export const isTaskItem = (node: ProseNode | null | undefined): boolean =>
  !!node && node.type.name === "list_item" && node.attrs.checked != null;

class TaskHandleView {
  private readonly content: HTMLElement;
  private readonly provider: BlockProvider;

  constructor(ctx: Ctx) {
    this.content = document.createElement("div");
    this.content.className = "ken-task-handle";
    this.content.title = "Drag to move";
    this.content.append(createElement(GripVertical, { width: 14, height: 14, "stroke-width": 1.75 }));
    this.provider = new BlockProvider({
      ctx,
      content: this.content,
      getOffset: () => 6,
      getPlacement: () => "left-start",
    });
    this.update();
  }

  update = () => this.provider.update();

  destroy = () => {
    this.provider.destroy();
    this.content.remove();
  };
}

/** Install the checklist handle (as Crepe installs its block handle). */
export function useTaskHandle(editor: Editor): void {
  editor
    .config((ctx) => {
      ctx.set(blockConfig.key, { filterNodes: (_pos, node) => isTaskItem(node) });
      ctx.set(block.key, { view: () => new TaskHandleView(ctx) });
    })
    .use(block);
}
