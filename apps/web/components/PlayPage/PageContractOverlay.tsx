import type { CSSProperties } from "react";
import type {
  AlignedHotspotV1,
  PagePlanV1,
  TextAnchorV1,
  TextBlockV1,
} from "@openflipbook/config";

const ANCHOR_CLASS: Record<TextAnchorV1, string> = {
  "top-left": "left-3 top-3 items-start text-left",
  top: "left-1/2 top-3 -translate-x-1/2 items-center text-center",
  "top-right": "right-3 top-3 items-end text-right",
  left: "left-3 top-1/2 -translate-y-1/2 items-start text-left",
  center: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center text-center",
  right: "right-3 top-1/2 -translate-y-1/2 items-end text-right",
  "bottom-left": "bottom-3 left-3 items-start text-left",
  bottom: "bottom-3 left-1/2 -translate-x-1/2 items-center text-center",
  "bottom-right": "bottom-3 right-3 items-end text-right",
};

export function textBlockClass(block: TextBlockV1): string {
  const size = block.role === "title"
    ? "max-w-[78%] text-[clamp(1.05rem,3vw,2rem)] font-semibold"
    : block.role === "subtitle"
      ? "max-w-[74%] text-[clamp(.85rem,2vw,1.25rem)] font-medium"
      : "max-w-[72%] text-[clamp(.72rem,1.45vw,1rem)]";
  return `absolute flex flex-col ${ANCHOR_CLASS[block.anchor]} ${size}`;
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
      aria-hidden="false"
      className="pointer-events-none absolute z-[6] overflow-hidden"
      style={frameStyle ?? { inset: 0 }}
    >
      {pagePlan.text_blocks.map((block) => (
        <div key={block.id} data-text-block-id={block.id} className={textBlockClass(block)}>
          <span className="rounded-md bg-[color:rgba(250,248,240,.86)] px-2 py-1 text-[var(--color-ink)] shadow-sm backdrop-blur-[2px]">
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
