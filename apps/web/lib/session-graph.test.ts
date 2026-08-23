import { describe, expect, it } from "vitest";

import {
  ancestryTrail,
  buildSessionGraph,
  findExplicitChild,
} from "./session-graph";

describe("session graph", () => {
  it("keeps ancestry primary while exposing branch points", () => {
    const graph = buildSessionGraph([
      { id: "root", created_at: "2026-08-22T00:00:00Z" },
      { id: "a", parent_id: "root", created_at: "2026-08-22T00:01:00Z" },
      { id: "b", parent_id: "root", created_at: "2026-08-22T00:02:00Z" },
      { id: "b1", parent_id: "b", created_at: "2026-08-22T00:03:00Z" },
    ]);
    expect(graph.branchPoints.has("root")).toBe(true);
    expect(graph.children.get("root")).toEqual(["a", "b"]);
    expect(ancestryTrail("b1", graph)).toEqual(["root", "b", "b1"]);
  });

  it("treats missing parents as roots for legacy rows", () => {
    const graph = buildSessionGraph([
      { id: "child", parent_id: "deleted", created_at: "2" },
      { id: "root", created_at: "1" },
    ]);
    expect(graph.roots).toEqual(["root", "child"]);
    expect(graph.parent.has("child")).toBe(false);
  });

  it("looks up explicit edges, chooses the newest duplicate, and isolates branches", () => {
    const nodes = [
      { id: "root", created_at: "2026-08-22T00:00:00Z" },
      {
        id: "old-a",
        parent_id: "root",
        source_hotspot_id: "h001",
        created_at: "2026-08-22T00:01:00Z",
      },
      {
        id: "new-a",
        parent_id: "root",
        source_hotspot_id: "h001",
        created_at: "2026-08-22T00:02:00Z",
      },
      {
        id: "branch-b",
        parent_id: "root",
        source_hotspot_id: "h002",
        created_at: "2026-08-22T00:03:00Z",
      },
      {
        id: "nested",
        parent_id: "new-a",
        source_hotspot_id: "h001",
        created_at: "2026-08-22T00:04:00Z",
      },
    ];
    const graph = buildSessionGraph(nodes);
    expect(graph.explicitEdges.get("root\u0000h001")).toBe("new-a");
    expect(findExplicitChild(nodes, "root", "h001")).toBe("new-a");
    expect(findExplicitChild(nodes, "root", "h002")).toBe("branch-b");
    expect(findExplicitChild(nodes, "root", "h003")).toBeNull();
    expect(findExplicitChild(nodes, "new-a", "h001")).toBe("nested");
  });
});
