import type { CSSProperties } from "react";
import type {
  AlignedHotspotV1,
  PagePlanV1,
  TextAnchorV1,
  TextBlockV1,
} from "@openflipbook/config";

const ANCHOR_CLASS: Record<TextAnchorV1, string> = {
  "top-left": "left-[clamp(.4rem,1.6vw,.75rem)] top-[clamp(.4rem,1.6vw,.75rem)] items-start text-left",
  top: "left-1/2 top-[clamp(.4rem,1.6vw,.75rem)] -translate-x-1/2 items-center text-center",
  "top-right": "right-[clamp(.4rem,1.6vw,.75rem)] top-[clamp(.4rem,1.6vw,.75rem)] items-end text-right",
  left: "left-[clamp(.4rem,1.6vw,.75rem)] top-1/2 -translate-y-1/2 items-start text-left",
  center: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center text-center",
  right: "right-[clamp(.4rem,1.6vw,.75rem)] top-1/2 -translate-y-1/2 items-end text-right",
  "bottom-left": "bottom-[clamp(.4rem,1.6vw,.75rem)] left-[clamp(.4rem,1.6vw,.75rem)] items-start text-left",
  bottom: "bottom-[clamp(.4rem,1.6vw,.75rem)] left-1/2 -translate-x-1/2 items-center text-center",
  "bottom-right": "bottom-[clamp(.4rem,1.6vw,.75rem)] right-[clamp(.4rem,1.6vw,.75rem)] items-end text-right",
};

export function textBlockClass(block: TextBlockV1): string {
  const size = block.role === "title"
    ? "max-w-[min(84%,34rem)] text-[clamp(.95rem,3vw,1.85rem)] font-semibold leading-tight"
    : block.role === "subtitle"
      ? "max-w-[min(82%,32rem)] text-[clamp(.8rem,2vw,1.15rem)] font-medium leading-snug"
      : "max-w-[min(80%,30rem)] text-[clamp(.7rem,1.45vw,.98rem)] leading-snug";
  return `absolute flex flex-col overflow-wrap-anywhere ${ANCHOR_CLASS[block.anchor]} ${size}`;
}

export interface PageContractOverlayProps {
  pagePlan: PagePlanV1;
  alignedHotspots?: readonly AlignedHotspotV1[];
  /** Pixel rect of the actual object-fit:contain image inside the figure. */
  imageRect?: { offsetX: number; offsetY: number; width: number; height: number } | null;
  showHotspots?: boolean;
}

export function PageContractOverlay({
  pagePlan,
  alignedHotspots = [],
  imageRect,
  showHotspots = false,
}: PageContractOverlayProps) {
  const frameStyle: CSSProperties | undefined = imageRect
    ? { left: imageRect.offsetX, top: imageRect.offsetY, width: imageRect.width, height: imageRect.height }
    : undefined;

  return (
    <div
      data-testid="page-contract-overlay"
      data-responsive-overlay="a3"
      aria-hidden="false"
      className="pointer-events-none absolute z-[6] overflow-hidden"
      style={frameStyle ?? { inset: 0 }}
    >
      {pagePlan.text_blocks.map((block) => (
        <div
          key={block.id}
          data-text-block-id={block.id}
          data-text-role={block.role}
          className={textBlockClass(block)}
        >
          <span className="max-w-full overflow-wrap-anywhere rounded-md bg-[color:rgba(250,248,240,.86)] px-[clamp(.4rem,1.4vw,.7rem)] py-[clamp(.25rem,.9vw,.45rem)] text-[var(--color-ink)] shadow-sm backdrop-blur-[2px]">
            {block.text}
          </span>
        </div>
      ))}

      {showHotspots && alignedHotspots.map((hotspot) => {
        const [x, y, w, h] = hotspot.actual_bbox;
        const planned = pagePlan.hotspots.find((candidate) => candidate.id === hotspot.id);
        return (
          <div
            key={hotspot.id}
            data-hotspot-id={hotspot.id}
            className="absolute rounded-md border border-dashed border-amber-500/60 bg-amber-200/10"
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
          >
            {planned && (
              <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
                {planned.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default PageContractOverlay;
