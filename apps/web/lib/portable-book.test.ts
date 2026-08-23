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

const secondPlan = {
  ...basePlan,
  hotspots: [
    ...basePlan.hotspots,
    {
      id: "h002",
      label: "飛輪",
      sub_query: "飛輪如何儲存動能？",
      visual_target: "flywheel",
      desired_bbox: [0.6, 0.1, 0.2, 0.2] as [number, number, number, number],
    },
  ],
};

const secondAligned = [
  ...aligned,
  {
    id: "h002",
    actual_bbox: [0.6, 0.1, 0.2, 0.2] as [number, number, number, number],
    tap_region: [[0.6, 0.1], [0.8, 0.1], [0.8, 0.3], [0.6, 0.3]] as [number, number][],
    alignment_confidence: 0.98,
  },
];

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

  it("prefers explicit provenance over coordinate fallback", () => {
    const book = buildPortableBook([
      {
        id: "root",
        session_id: "session_explicit",
        parent_id: null,
        query: "root",
        page_title: "Root",
        image_asset: "images/root.jpg",
        page_plan: secondPlan,
        aligned_hotspots: secondAligned,
        created_at: "2026-08-21T01:00:00Z",
      },
      {
        id: "legacy-h001",
        session_id: "session_explicit",
        parent_id: "root",
        query: "legacy",
        page_title: "Legacy",
        image_asset: "images/legacy.jpg",
        click_in_parent: { x_pct: 0.2, y_pct: 0.2 },
        created_at: "2026-08-21T01:01:00Z",
      },
      {
        id: "explicit-h002",
        session_id: "session_explicit",
        parent_id: "root",
        source_hotspot_id: "h002",
        query: "explicit",
        page_title: "Explicit",
        image_asset: "images/explicit.jpg",
        // Deliberately points at h001: the explicit edge must win.
        click_in_parent: { x_pct: 0.2, y_pct: 0.2 },
        created_at: "2026-08-21T01:02:00Z",
      },
    ]);
    const root = book.nodes.find((node) => node.id === "root")!;
    expect(root.source_hotspot_id).toBeNull();
    expect(root.hotspots.find((hotspot) => hotspot.id === "h001")?.target_node_id)
      .toBe("legacy-h001");
    expect(root.hotspots.find((hotspot) => hotspot.id === "h002")?.target_node_id)
      .toBe("explicit-h002");
    expect(book.nodes.find((node) => node.id === "explicit-h002")?.source_hotspot_id)
      .toBe("h002");
  });

  it("does not coordinate-fallback an invalid explicit edge", () => {
    const book = buildPortableBook([
      {
        id: "root",
        session_id: "session_invalid_explicit",
        parent_id: null,
        query: "root",
        page_title: "Root",
        image_asset: "images/root.jpg",
        page_plan: basePlan,
        aligned_hotspots: aligned,
        created_at: "2026-08-21T01:00:00Z",
      },
      {
        id: "invalid",
        session_id: "session_invalid_explicit",
        parent_id: "root",
        source_hotspot_id: "h999",
        query: "invalid",
        page_title: "Invalid",
        image_asset: "images/invalid.jpg",
        click_in_parent: { x_pct: 0.2, y_pct: 0.2 },
        created_at: "2026-08-21T01:01:00Z",
      },
    ]);
    expect(book.nodes[0]!.hotspots[0]!.target_node_id).toBeNull();
    expect(book.nodes[1]!.source_hotspot_id).toBe("h999");
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
