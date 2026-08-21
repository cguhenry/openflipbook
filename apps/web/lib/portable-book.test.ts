import { describe, expect, it } from "vitest";
import type { OfflineSourceNode } from "./portable-book";
import { buildPortableBook, portableBookScript } from "./portable-book";

const basePlan = {
  schema_version: "1.0" as const,
  title: "蒸汽機",
  summary: "fixture",
  scene: { prompt: "no text", style: "textbook", aspect_ratio: "16:9" as const },
  text_blocks: [
    { id: "t001", role: "title" as const, text: "蒸汽機如何運作", anchor: "top-left" as const },
    { id: "t002", role: "body" as const, text: "蒸汽推動活塞。", anchor: "bottom-left" as const },
  ],
  hotspots: [
    {
      id: "h001",
      label: "活塞",
      sub_query: "活塞如何運作？",
      visual_target: "piston",
      desired_bbox: [0.1, 0.1, 0.3, 0.4] as [number, number, number, number],
    },
  ],
  motion_hints: [],
  sources: [],
};

const aligned = [{
  id: "h001",
  actual_bbox: [0.1, 0.1, 0.3, 0.4] as [number, number, number, number],
  tap_region: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] as [number, number][],
  alignment_confidence: 0.99,
}];

function rows(): OfflineSourceNode[] {
  return [
    {
      id: "root",
      session_id: "session_test",
      parent_id: null,
      query: "steam engine",
      page_title: "蒸汽機",
      image_asset: "images/root.jpg",
      page_plan: basePlan,
      aligned_hotspots: aligned,
      created_at: "2026-08-21T01:00:00Z",
    },
    {
      id: "child-old",
      session_id: "session_test",
      parent_id: "root",
      query: "piston old",
      page_title: "舊活塞頁",
      image_asset: "images/child-old.jpg",
      click_in_parent: { x_pct: 0.2, y_pct: 0.2 },
      created_at: "2026-08-21T01:01:00Z",
    },
    {
      id: "child-new",
      session_id: "session_test",
      parent_id: "root",
      query: "piston new",
      page_title: "新活塞頁",
      image_asset: "images/child-new.jpg",
      click_in_parent: { x_pct: 0.25, y_pct: 0.3 },
      created_at: "2026-08-21T01:02:00Z",
    },
  ];
}

describe("portable offline manifest", () => {
  it("retains every node and maps the newest explored child to a hotspot", () => {
    const book = buildPortableBook(rows());
    expect(book.nodes).toHaveLength(3);
    expect(book.root_node_id).toBe("root");
    const root = book.nodes.find((node) => node.id === "root")!;
    expect(root.hotspots[0]!.target_node_id).toBe("child-new");
  });

  it("keeps a stable root and deterministic ordering when input order changes", () => {
    const book = buildPortableBook(rows().reverse());
    expect(book.root_node_id).toBe("root");
    expect(book.nodes.map((node) => node.id)).toEqual(["root", "child-old", "child-new"]);
  });

  it("preserves exact Traditional Chinese DOM text", () => {
    const book = buildPortableBook(rows());
    expect(book.nodes[0]!.text_blocks.map((block) => block.text)).toContain("蒸汽機如何運作");
    expect(book.nodes[0]!.text_blocks.map((block) => block.text)).toContain("蒸汽推動活塞。");
  });

  it("exports old/no-contract nodes without crashing", () => {
    const book = buildPortableBook([{
      id: "legacy",
      session_id: "session_legacy",
      parent_id: null,
      query: "legacy",
      page_title: "舊頁面",
      image_asset: "images/legacy.jpg",
      created_at: "2026-08-21T01:00:00Z",
    }]);
    expect(book.nodes[0]!.hotspots).toEqual([]);
    expect(book.nodes[0]!.text_blocks).toEqual([]);
  });

  it("emits a classic-script payload rather than requiring fetch", () => {
    const script = portableBookScript(buildPortableBook(rows()));
    expect(script).toContain("window.OPENFLIPBOOK_OFFLINE_BOOK=");
    expect(script).not.toContain("fetch(");
  });
});
