import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RelatedTopicsTray } from "./RelatedTopicsTray";

describe("RelatedTopicsTray", () => {
  it("renders text chips and emits exactly the selected topic", () => {
    const onPick = vi.fn();
    render(
      <RelatedTopicsTray
        topics={["Harbor history", "Tide gates", "Shipwrights"]}
        loading={false}
        error={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("related-topics-tray")).toBeTruthy();
    expect(screen.getByTestId("related-topic-chips")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate a page about Harbor history" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("Harbor history");
  });

  it("shows a localized empty state instead of the old neighbour wording", () => {
    render(
      <RelatedTopicsTray
        topics={[]}
        loading={false}
        error={false}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("No related topics found.")).toBeTruthy();
    expect(screen.queryByText("No neighbours found nearby")).toBeNull();
  });
});
