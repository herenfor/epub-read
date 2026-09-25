/** Only controls owned by this card suppress its default open/select action. */
const CARD_ACTION_SELECTOR = [
  "button", "input", "select", "textarea", "a[href]",
  ".shelf-card-actions-wrap", ".shelf-card-pop-menu", ".shelf-card-star-btn",
  ".shelf-confirm-backdrop", ".shelf-confirm", "dialog", "[role='dialog']",
].join(", ");

export function isShelfCardActionTarget(
  target: EventTarget | null,
  card: Element,
): boolean {
  const ElementCtor = typeof Element === "undefined" ? null : Element;
  if (!ElementCtor || !(target instanceof ElementCtor)) return false;
  const action = target.closest(CARD_ACTION_SELECTOR);
  // A folder dialog contains the card, but is not an action inside the card.
  return action !== null && action !== card && card.contains(action);
}
