import { describe, expect, it } from "vitest";
import { classifySliderGesture, sliderDragValue } from "./TouchSlider";
import { textBoxFromApplied } from "./readerPageBox";

describe("touch slider", () => {
  it("waits inside the slop, then a sideways move drags and a vertical one scrolls", () => {
    expect(classifySliderGesture(5, 3)).toBe("pending");
    expect(classifySliderGesture(12, 4)).toBe("drag");
    expect(classifySliderGesture(-12, 2)).toBe("drag");
    expect(classifySliderGesture(4, 12)).toBe("scroll");
    // A diagonal swipe is a scroll, not a value change.
    expect(classifySliderGesture(10, 10)).toBe("scroll");
  });

  it("moves by the finger's travel from the starting value, on the step grid", () => {
    expect(sliderDragValue(5, 0, 200, 0, 12, 1)).toBe(5);
    expect(sliderDragValue(5, 50, 200, 0, 12, 1)).toBe(8);
    expect(sliderDragValue(5, -500, 200, 0, 12, 1)).toBe(0);
    expect(sliderDragValue(50, 10, 200, 0, 100, 5)).toBe(55);
  });
});

describe("margin guide box", () => {
  it("comes from the applied insets, automatic sides included, never from guessed zeros", () => {
    // Only left was set (20); the paginator applied automatic top 42, bottom 34, right 20.
    const box = textBoxFromApplied({ left: 0, right: 390, top: 0 }, 0, 844, { left: 20, right: 20, top: 42, bottom: 34 })!;
    expect([box.left, box.top, box.right, box.bottom]).toEqual([20, 42, 370, 810]);
    expect(textBoxFromApplied({ left: 0, right: 30, top: 0 }, 0, 100, { left: 20, right: 20, top: 0, bottom: 0 })).toBeNull();
  });
});
