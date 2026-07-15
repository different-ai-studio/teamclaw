import React from "react";
import { describe, expect, it, vi } from "vitest";

type ElementWithProps = React.ReactElement<{
  children?: React.ReactNode;
  style?: unknown;
}>;

vi.mock("react-native", () => {
  const makeComponent =
    (name: string) =>
    (props: Record<string, unknown>) =>
      React.createElement(name, props, props.children as React.ReactNode);

  return {
    Pressable: makeComponent("Pressable"),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: makeComponent("Text"),
    View: makeComponent("View"),
    Platform: {
      OS: "ios",
      select: (values: Record<string, unknown>) => values.ios ?? values.default,
    },
  };
});

function elementChildren(element: ElementWithProps): ElementWithProps[] {
  return React.Children.toArray(element.props.children).filter(
    React.isValidElement,
  ) as ElementWithProps[];
}

describe("PageHeader", () => {
  it("places the title between equal-width left and right action slots", async () => {
    const { PageHeader } = await import("../ui/PageHeader");

    const header = PageHeader({
      count: 4,
      left: React.createElement("LeftAction"),
      right: React.createElement("RightAction"),
      title: "Sessions",
    }) as ElementWithProps;

    const [leftSlot, titleBlock, rightSlot] = elementChildren(header);

    expect(header.props.style).toMatchObject({ flexDirection: "row" });
    expect(leftSlot.props.style).toMatchObject({ width: 80 });
    expect(titleBlock.props.style).toMatchObject({ alignItems: "center", flex: 1 });
    expect(rightSlot.props.style).toMatchObject({ width: 80 });
    expect(elementChildren(titleBlock)).toHaveLength(2);
  });
});
