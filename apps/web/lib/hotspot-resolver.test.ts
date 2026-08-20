import { describe, expect, it } from "vitest";
import type { AlignedHotspotV1, PagePlanV1 } from "@openflipbook/config";
import { deterministicTapPrefetch, pointInPolygon, resolveHotspot } from "./hotspot-resolver";

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

  it("returns null only outside the image or without valid hotspot ids", () => {
    expect(resolveHotspot(plan, aligned, -0.01, 0.5)).toBeNull();
    expect(resolveHotspot(plan, [{ ...aligned[0]!, id: "missing" }], 0.2, 0.2)).toBeNull();
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
});
