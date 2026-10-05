import { describe, expect, it } from "vitest";
import { planCenteredTitleBody, type CenteredTitleBodyPlanInput } from "./titlePageLayout";

function input(overrides: Partial<CenteredTitleBodyPlanInput> = {}): CenteredTitleBodyPlanInput {
  return {
    reflowableHorizontal: true,
    singleHeading: true,
    bodyDisplay: "flex",
    bodyFlexDirection: "column",
    bodyFlexWrap: "nowrap",
    bodyJustifyContent: "center",
    bodyAlignItems: "center",
    titleOuterHeight: 80,
    columnContentHeight: 640,
    ...overrides,
  };
}

describe("planCenteredTitleBody", () => {
  it("plans a full-column inner layout for an author body flex-centered short title", () => {
    expect(planCenteredTitleBody(input())).toEqual({ heightPx: 640 });
  });

  it("rejects non-reflowable, non-heading, wrong flex and oversized title pages", () => {
    expect(planCenteredTitleBody(input({ reflowableHorizontal: false }))).toBeNull();
    expect(planCenteredTitleBody(input({ singleHeading: false }))).toBeNull();
    expect(planCenteredTitleBody(input({ bodyDisplay: "block" }))).toBeNull();
    expect(planCenteredTitleBody(input({ bodyFlexDirection: "row" }))).toBeNull();
    expect(planCenteredTitleBody(input({ bodyFlexWrap: "wrap" }))).toBeNull();
    expect(planCenteredTitleBody(input({ bodyJustifyContent: "flex-start" }))).toBeNull();
    expect(planCenteredTitleBody(input({ bodyAlignItems: "flex-start" }))).toBeNull();
    expect(planCenteredTitleBody(input({ titleOuterHeight: 640 }))).toBeNull();
    expect(planCenteredTitleBody(input({ columnContentHeight: 0 }))).toBeNull();
  });
});
