import type { PlainMessageKey } from "./localization/core";

/**
 * The single list of shelf menu actions. The desktop popover and the touch
 * bottom sheet render the same descriptors; an action appears only when the
 * shelf really has a handler for it.
 */

export type ShelfActionGroup = "read" | "organize" | "danger";
export type ShelfBookActionId = "open" | "select" | "favorite" | "unfavorite" | "move" | "removeFromFolder" | "exportBook" | "delete";
export type ShelfFolderActionId = "openFolder" | "renameFolder" | "dissolveFolder";
export type ShelfActionId = ShelfBookActionId | ShelfFolderActionId;

export interface ShelfAction {
  id: ShelfActionId;
  group: ShelfActionGroup;
  label: PlainMessageKey;
  /** Label while this action's own async request is in flight. */
  pendingLabel?: PlainMessageKey;
  disabled: boolean;
}

export interface ShelfBookActionContext {
  favorite: boolean;
  inFolder: boolean;
  /** Global busy (open/delete in progress): data-writing actions wait. */
  busy: boolean;
  /** Native import running: deletion conflicts with it. */
  deleteDisabled: boolean;
  /** Surfaces without selection mode (folder dialog) leave this off. */
  canSelect: boolean;
  canFavorite: boolean;
  canMove: boolean;
  canRemoveFromFolder: boolean;
  /** SBE-U: only shelves that can save the original EPUB show the action. */
  canExport?: boolean;
  /** Another export/import or a LAN transfer holds the save-file slot. */
  exportDisabled?: boolean;
}

export function shelfBookActions(ctx: ShelfBookActionContext): ShelfAction[] {
  const actions: ShelfAction[] = [{ id: "open", group: "read", label: "shelf.card.open", disabled: false }];
  if (ctx.canFavorite) {
    actions.push(ctx.favorite
      ? { id: "unfavorite", group: "organize", label: "shelf.card.unfavorite", disabled: ctx.busy }
      : { id: "favorite", group: "organize", label: "shelf.card.favorite", disabled: ctx.busy });
  }
  if (ctx.canMove) actions.push({ id: "move", group: "organize", label: "shelf.card.moveToFolder", disabled: ctx.busy });
  if (ctx.canRemoveFromFolder && ctx.inFolder) {
    actions.push({
      id: "removeFromFolder", group: "organize", label: "shelf.card.removeFromFolder",
      pendingLabel: "shelf.card.removing", disabled: ctx.busy,
    });
  }
  if (ctx.canExport) actions.push({ id: "exportBook", group: "organize", label: "bookExport.action", disabled: ctx.busy || Boolean(ctx.exportDisabled) });
  if (ctx.canSelect) actions.push({ id: "select", group: "organize", label: "shelf.card.select", disabled: false });
  actions.push({ id: "delete", group: "danger", label: "shelf.card.delete", disabled: ctx.busy || ctx.deleteDisabled });
  return actions;
}

export function shelfFolderActions(): ShelfAction[] {
  return [
    { id: "openFolder", group: "read", label: "shelfFolder.open", disabled: false },
    { id: "renameFolder", group: "organize", label: "shelfFolder.rename", disabled: false },
    { id: "dissolveFolder", group: "danger", label: "shelfFolder.dissolve", disabled: false },
  ];
}

const GROUP_ORDER: readonly ShelfActionGroup[] = ["read", "organize", "danger"];

/** Groups in display order; empty groups are dropped so separators never double up. */
export function groupShelfActions(actions: readonly ShelfAction[]): Array<{ group: ShelfActionGroup; actions: ShelfAction[] }> {
  return GROUP_ORDER
    .map((group) => ({ group, actions: actions.filter((action) => action.group === group) }))
    .filter((entry) => entry.actions.length > 0);
}

/** Touch and pen open the bottom sheet; mouse opens the popover; keyboard follows the device. */
export function shelfMenuPresentation(pointerType: string | undefined, touchDevice: boolean): "sheet" | "popover" {
  if (pointerType === "touch" || pointerType === "pen") return "sheet";
  if (pointerType === "mouse") return "popover";
  return touchDevice ? "sheet" : "popover";
}
