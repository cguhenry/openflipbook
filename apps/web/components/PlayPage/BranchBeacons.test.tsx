import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BranchBeacons } from "./BranchBeacons";

describe("BranchBeacons", () => {
  it("shows an existing-child chooser and only navigates to persisted ids", () => {
    const html = renderToStaticMarkup(
      <BranchBeacons
        onSelect={() => {}}
        beacons={[
          { nodeId: "child-a", title: "First branch", clickInParent: { xPct: 0.2, yPct: 0.3 } },
          { nodeId: "child-b", title: "Second branch", clickInParent: { xPct: 0.7, yPct: 0.3 } },
        ]}
      />,
    );
    expect(html).toContain('data-testid="branch-chooser"');
    expect(html).toContain('title="Second branch"');
    expect(html).toContain('title="Branch: Second branch"');
    expect(html).toContain("Second branch");
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("absolute z-10 flex h-11 w-11");
  });
});
