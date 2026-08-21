import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PagePlanV1 } from "@openflipbook/config";
import { PageContractOverlay, textBlockClass } from "./PageContractOverlay";

const plan: PagePlanV1 = {
  schema_version: "1.0",
  title: "蒸汽機如何運作",
  summary: "DOM text fixture",
  scene: { prompt: "steam engine cutaway, no text, no labels", style: "textbook", aspect_ratio: "16:9" },
  text_blocks: [
    { id: "t001", role: "title", text: "蒸汽機如何運作", anchor: "top-left" },
    { id: "t002", role: "body", text: "蒸汽推動活塞，再帶動飛輪。", anchor: "bottom-left" },
  ],
  hotspots: [
    { id: "h001", label: "活塞", sub_query: "活塞如何運作？", visual_target: "piston", desired_bbox: [0.4, 0.25, 0.25, 0.45] },
    { id: "h002", label: "飛輪", sub_query: "飛輪有何作用？", visual_target: "flywheel", desired_bbox: [0.7, 0.25, 0.2, 0.5] },
  ],
  motion_hints: [],
  sources: [],
};

describe("PageContractOverlay", () => {
  it("renders exact DOM text instead of baking it into the image", () => {
    const html = renderToStaticMarkup(<PageContractOverlay pagePlan={plan} />);
    expect(html).toContain("蒸汽機如何運作");
    expect(html).toContain("蒸汽推動活塞，再帶動飛輪。");
    expect(html).toContain('data-text-block-id="t001"');
  });

  it("never steals pointer events from the underlying image click handler", () => {
    const html = renderToStaticMarkup(<PageContractOverlay pagePlan={plan} />);
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('data-responsive-overlay="a3"');
  });

  it("maps anchors to responsive absolute layout classes", () => {
    expect(textBlockClass(plan.text_blocks[0]!)).toContain("top-[clamp");
    expect(textBlockClass(plan.text_blocks[1]!)).toContain("bottom-[clamp");
    expect(textBlockClass(plan.text_blocks[0]!)).toContain("clamp");
    expect(textBlockClass(plan.text_blocks[0]!)).toContain("min(84%,34rem)");
    expect(textBlockClass(plan.text_blocks[1]!)).toContain("leading-snug");
  });
});
