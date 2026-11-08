/** Exact snapshot/restore of one inline style longhand, including !important. */
export interface InlineStyleValue {
  value: string;
  priority: string;
}

export function snapshotInlineStyleProperty(
  style: CSSStyleDeclaration,
  property: string
): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

/** 恢复 inline 属性时同时恢复 !important，空值则彻底移除 longhand。 */
export function restoreInlineStyleProperty(
  style: CSSStyleDeclaration,
  property: string,
  original: InlineStyleValue
): void {
  if (original.value === "") style.removeProperty(property);
  else style.setProperty(property, original.value, original.priority);
}
