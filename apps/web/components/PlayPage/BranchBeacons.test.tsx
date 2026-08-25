import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BranchBeacons, BranchChooser } from "./BranchBeacons";

describe("BranchBeacons", () => {
  const beacons = [
    { nodeId: "child-a", title: "First branch", clickInParent: { xPct: 0.2, yPct: 0.3 } },
    { nodeId: "child-b", title: "Second branch", clickInParent: { xPct: 0.7, yPct: 0.3 } },
  ];

  it("keeps only persisted click-origin beacons on the image", () => {
    const html = renderToStaticMarkup(
      <BranchBeacons
        onSelect={() => {}}
        beacons={beacons}
      />,
    );
    expect(html).toContain('title="Branch: Second branch"');
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("absolute z-10 flex h-11 w-11");
    expect(html).not.toContain('data-testid="branch-chooser"');
  });

  it("renders the textual chooser in document flow", () => {
    const html = renderToStaticMarkup(
      <BranchChooser onSelect={() => {}} beacons={beacons} />,
    );
    expect(html).toContain('data-testid="branch-chooser"');
    expect(html).toContain('title="Second branch"');
    expect(html).toContain("Second branch");
    expect(html).toContain("flex w-full flex-wrap");
    expect(html).not.toContain("absolute");
  });
});
