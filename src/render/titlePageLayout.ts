export interface CenteredTitleBodyPlanInput {
  reflowableHorizontal: boolean;
  singleHeading: boolean;
  bodyDisplay: string;
  bodyFlexDirection: string;
  bodyFlexWrap: string;
  bodyJustifyContent: string;
  bodyAlignItems: string;
  /** 标题自己的高度，包含上下 margin。 */
  titleOuterHeight: number;
  /** 本列有效内容高；滚动模式为可见视口有效高。 */
  columnContentHeight: number;
}

/**
 * 严格受限的短标题卷首页布局判定。
 *
 * 只接受：可重排横排、正文直接内容只有一个标题、原 body 为
 * `display:flex; flex-direction:column; flex-wrap:nowrap; justify-content:center;
 * align-items:center`，且标题外高小于本列有效内容高。命中后返回读者拥有的
 * 内层布局盒高度；其他卷页保持旧路径。
 */
export function planCenteredTitleBody(
  input: CenteredTitleBodyPlanInput
): { heightPx: number } | null {
  if (!input.reflowableHorizontal || !input.singleHeading) return null;
  if (
    input.bodyDisplay !== "flex" ||
    input.bodyFlexDirection !== "column" ||
    input.bodyFlexWrap !== "nowrap" ||
    input.bodyJustifyContent !== "center" ||
    input.bodyAlignItems !== "center"
  ) {
    return null;
  }
  if (
    !Number.isFinite(input.titleOuterHeight) ||
    !Number.isFinite(input.columnContentHeight) ||
    input.columnContentHeight <= 0 ||
    input.titleOuterHeight < 0 ||
    input.titleOuterHeight >= input.columnContentHeight
  ) {
    return null;
  }
  return { heightPx: input.columnContentHeight };
}
