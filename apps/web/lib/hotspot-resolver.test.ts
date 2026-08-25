import { describe, expect, it } from "vitest";
import type { AlignedHotspotV1, PagePlanV1 } from "@openflipbook/config";
import {
  deterministicTapPrefetch,
  canonicalHotspotRows,
  hotspotIntentAtPoint,
  hotspotIntentById,
  pointInPolygon,
  resolveHotspot,
} from "./hotspot-resolver";

const plan: PagePlanV1 = {
  schema_version: "1.0",
  title: "蒸汽機",
  summary: "test",
  scene: { prompt: "steam engine, no text, no labels", style: "diagram", aspect_ratio: "16:9" },
  text_blocks: [],
  hotspots: [
    { id: "h001", label: "鍋爐", sub_query: "鍋爐如何產生蒸汽？", visual_target: "boiler", desired_bbox: [0.05, 0.1, 0.35, 0.8] },
    { id: "h002", label: "活塞", sub_query: "活塞如何運作？", visual_target: "piston", desired_bbox: [0.6, 0.1, 0.35, 0.8] },
  ],
  motion_hints: [],
  sources: [],
};

const aligned: AlignedHotspotV1[] = [
  { id: "h001", actual_bbox: [0.08, 0.2, 0.25, 0.5], tap_region: [[0, 0], [0.48, 0], [0.48, 1], [0, 1]], alignment_confidence: 0.95 },
  { id: "h002", actual_bbox: [0.68, 0.2, 0.2, 0.5], tap_region: [[0.52, 0], [1, 0], [1, 1], [0.52, 1]], alignment_confidence: 0.9 },
];

describe("deterministic hotspot resolver", () => {
  it("treats polygon boundaries as hits", () => {
    expect(pointInPolygon(0, 0.5, aligned[0]!.tap_region)).toBe(true);
  });

  it("resolves semantic tap regions without ambiguity", () => {
    expect(resolveHotspot(plan, aligned, 0.2, 0.4)).toMatchObject({ method: "tap_region", planned: { id: "h001" } });
    expect(resolveHotspot(plan, aligned, 0.8, 0.4)).toMatchObject({ method: "tap_region", planned: { id: "h002" } });
  });

  it("uses the highest confidence hotspot for a stable overlap", () => {
    const overlap: AlignedHotspotV1[] = aligned.map((hotspot, index) => ({
      ...hotspot,
      tap_region: [[0, 0], [1, 0], [1, 1], [0, 1]],
      alignment_confidence: index === 0 ? 0.8 : 0.9,
    }));
    expect(resolveHotspot(plan, overlap, 0.5, 0.5)).toMatchObject({ planned: { id: "h002" } });
    expect(resolveHotspot(plan, overlap.map((hotspot) => ({ ...hotspot, alignment_confidence: 0.8 })), 0.5, 0.5)).toMatchObject({ planned: { id: "h001" } });
  });

  it("falls back to the aligned bbox when no polygon contains the point", () => {
    const bboxOnly: AlignedHotspotV1[] = [{
      ...aligned[0]!,
      tap_region: [[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02]],
      actual_bbox: [0.4, 0.4, 0.2, 0.2] as const,
    }];
    expect(resolveHotspot(plan, bboxOnly, 0.5, 0.5)).toMatchObject({ method: "bbox", planned: { id: "h001" } });
  });

  it("fills an uncovered gap by nearest actual object", () => {
    expect(resolveHotspot(plan, aligned, 0.49, 0.5)).toMatchObject({ method: "nearest", planned: { id: "h001" } });
  });

  it("uses planned geometry when aligned rows are absent", () => {
    expect(resolveHotspot(plan, aligned, -0.01, 0.5)).toBeNull();
    expect(resolveHotspot(plan, [{ ...aligned[0]!, id: "missing" }], 0.2, 0.2)).toMatchObject({
      method: "planned_fallback",
      geometry_source: "planned_fallback",
      planned: { id: "h001" },
    });
  });

  it("converts a hit into the existing warm-tap fields", () => {
    const hit = resolveHotspot(plan, aligned, 0.8, 0.4)!;
    expect(deterministicTapPrefetch(hit)).toEqual({
      subject: "活塞",
      style: "",
      subject_context: "活塞如何運作？",
      groundable: true,
      confidence: 0.9,
    });
  });

  it("keeps label ids, queries, and geometric hits on one semantic intent", () => {
    for (const [index, hotspot] of plan.hotspots.entries()) {
      const direct = hotspotIntentById(plan, aligned, hotspot.id);
      expect(direct).toMatchObject({
        hotspot_id: hotspot.id,
        sub_query: hotspot.sub_query,
        visual_target: hotspot.visual_target,
      });
      const [x, y, width, height] = aligned[index]!.actual_bbox;
      expect(
        hotspotIntentAtPoint(plan, aligned, x + width / 2, y + height / 2),
      ).toMatchObject({
        hotspot_id: hotspot.id,
        sub_query: hotspot.sub_query,
      });
    }
  });

  it("keeps all planned ids addressable with desired_bbox fallback", () => {
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
    const richAligned = richPlan.hotspots.slice(0, 5).map((hotspot): AlignedHotspotV1 => ({
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

    const rows = canonicalHotspotRows(richPlan, richAligned);
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.geometry_source === "aligned")).toHaveLength(5);
    expect(rows.filter((row) => row.geometry_source === "planned_fallback")).toHaveLength(3);

    for (const hotspot of richPlan.hotspots) {
      expect(hotspotIntentById(richPlan, richAligned, hotspot.id)).toMatchObject({
        hotspot_id: hotspot.id,
        sub_query: hotspot.sub_query,
      });
    }
    const fallback = richPlan.hotspots[5]!;
    const [x, y, width, height] = fallback.desired_bbox;
    expect(resolveHotspot(richPlan, richAligned, x + width / 2, y + height / 2)).toMatchObject({
      method: "planned_fallback",
      geometry_source: "planned_fallback",
      planned: { id: fallback.id },
    });
  });
});
