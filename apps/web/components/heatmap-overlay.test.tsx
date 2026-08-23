import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HeatmapOverlay from "./heatmap-overlay";

describe("HeatmapOverlay persisted thumbnails", () => {
  it("prefers the same-origin browser URL over the legacy storage URL", () => {
    const { container, getByTitle } = render(
      <HeatmapOverlay
        parentId="parent-1"
        children={[{
          id: "child-1",
          page_title: "Child",
          image_url: "http://localhost:9000/openflipbook/child.png",
          browser_image_url: "/api/image/child-1",
          click_in_parent: { x_pct: 0.5, y_pct: 0.5 },
          created_at: "2026-08-24T00:00:00.000Z",
        }]}
      />,
    );

    fireEvent.mouseEnter(getByTitle("Child"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/image/child-1",
    );
  });
});
