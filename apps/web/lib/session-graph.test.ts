import { describe, expect, it } from "vitest";

import { ancestryTrail, buildSessionGraph } from "./session-graph";

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
});
