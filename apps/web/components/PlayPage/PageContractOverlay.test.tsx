import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AlignedHotspotV1, PagePlanV1 } from "@openflipbook/config";
import { PageContractOverlay, textBlockClass } from "./PageContractOverlay";

const plan: PagePlanV1 = {
  schema_version: "1.0",
  title: "蒸汽機如何運作",
  summary: "DOM text fixture",
  scene: { prompt: "steam engine cutaway, no text, no labels", style: "textbook", aspect_ratio: "16:9" },
  text_blocks: [
    { id: "t001", role: "title", text: "蒸汽機如何運作", anchor: "top-left", source_ids: ["S1"] },
    { id: "t003", role: "subtitle", text: "從壓力到動力", anchor: "top", source_ids: ["S1"] },
    { id: "t002", role: "body", text: "蒸汽推動活塞，再帶動飛輪。", anchor: "bottom-left", source_ids: ["S1"] },
  ],
  hotspots: [
    { id: "h001", label: "活塞", sub_query: "活塞如何運作？", visual_target: "piston", desired_bbox: [0.4, 0.25, 0.25, 0.45] },
    { id: "h002", label: "飛輪", sub_query: "飛輪有何作用？", visual_target: "flywheel", desired_bbox: [0.7, 0.25, 0.2, 0.5] },
  ],
  motion_hints: [],
  sources: [{ id: "S1", title: "Steam reference", url: "https://example.com", snippet: "fixture" }],
};

describe("PageContractOverlay", () => {
  it("renders exact DOM text instead of baking it into the image", () => {
    const html = renderToStaticMarkup(<PageContractOverlay pagePlan={plan} />);
    expect(html).toContain("蒸汽機如何運作");
    expect(html).toContain("蒸汽推動活塞，再帶動飛輪。");
    expect(html).toContain('data-text-block-id="t001"');
    expect(html).toContain("[1]");
    expect((html.match(/data-source-marker="1"/g) ?? []).length).toBe(1);
  });

  it("keeps empty overlay space click-through while DOM text remains selectable", () => {
    const html = renderToStaticMarkup(<PageContractOverlay pagePlan={plan} />);
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("pointer-events-auto");
    expect(html).toContain("cursor-text select-text");
    expect(html).toContain('data-responsive-overlay="a3"');
  });

  it("maps anchors to responsive absolute layout classes", () => {
    expect(textBlockClass(plan.text_blocks[0]!)).toContain("top-[clamp");
    expect(textBlockClass(plan.text_blocks[2]!)).toContain("bottom-[clamp");
    expect(textBlockClass(plan.text_blocks[0]!)).toContain("clamp");
    expect(textBlockClass(plan.text_blocks[0]!)).toContain("min(84%,34rem)");
    expect(textBlockClass(plan.text_blocks[2]!)).toContain("leading-snug");
  });

  it("renders non-empty first-class hotspot labels with exact ids", () => {
    const html = renderToStaticMarkup(
      <PageContractOverlay
        pagePlan={plan}
        alignedHotspots={[
          { id: "h001", actual_bbox: [0.4, 0.25, 0.25, 0.45], tap_region: [[0.4, 0.25], [0.65, 0.25], [0.65, 0.7], [0.4, 0.7]], alignment_confidence: 0.95 },
          { id: "h002", actual_bbox: [0.7, 0.25, 0.2, 0.5], tap_region: [[0.7, 0.25], [0.9, 0.25], [0.9, 0.75], [0.7, 0.75]], alignment_confidence: 0.9 },
        ]}
        showHotspots
      />,
    );
    expect((html.match(/data-hotspot-label="true"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-hotspot-id="h001"');
    expect(html).toContain('data-hotspot-id="h002"');
    expect(html).toContain('aria-label="活塞"');
    expect(html).toContain('aria-label="飛輪"');
    expect(html).toContain(">活塞</button>");
    expect(html).toContain(">飛輪</button>");
  });

  it("renders one visible label per rich planned hotspot with fallback diagnostics", () => {
    const richPlan: PagePlanV1 = {
      ...plan,
      hotspots: Array.from({ length: 8 }, (_, index) => ({
        id: `h${String(index + 1).padStart(3, "0")}`,
        label: `區域 ${index + 1}`,
        sub_query: `區域 ${index + 1} 的作用？`,
        visual_target: `distinct region ${index + 1}`,
        desired_bbox: [
          (index % 4) * 0.24 + 0.02,
          Math.floor(index / 4) * 0.38 + 0.12,
          0.18,
          0.24,
        ],
      })),
    };
    const aligned = richPlan.hotspots.slice(0, 5).map((hotspot): AlignedHotspotV1 => ({
      id: hotspot.id,
      actual_bbox: hotspot.desired_bbox,
      tap_region: [
        [hotspot.desired_bbox[0], hotspot.desired_bbox[1]],
        [hotspot.desired_bbox[0] + hotspot.desired_bbox[2], hotspot.desired_bbox[1]],
        [hotspot.desired_bbox[0] + hotspot.desired_bbox[2], hotspot.desired_bbox[1] + hotspot.desired_bbox[3]],
        [hotspot.desired_bbox[0], hotspot.desired_bbox[1] + hotspot.desired_bbox[3]],
      ],
      alignment_confidence: 0.9,
    }));
    const html = renderToStaticMarkup(
      <PageContractOverlay pagePlan={richPlan} alignedHotspots={aligned} showHotspots />,
    );

    expect(html).toContain('data-planned-hotspot-count="8"');
    expect(html).toContain('data-aligned-hotspot-count="5"');
    expect(html).toContain('data-visible-label-count="8"');
    expect(html).toContain('data-fallback-label-count="3"');
    expect((html.match(/data-hotspot-label="true"/g) ?? []).length).toBe(8);
    expect((html.match(/data-geometry-source="planned_fallback"/g) ?? []).length).toBe(3);
    for (const hotspot of richPlan.hotspots) {
      expect(html).toContain(`data-hotspot-id="${hotspot.id}"`);
      expect(html).toContain(`>${hotspot.label}</button>`);
    }
  });
});
