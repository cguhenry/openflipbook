import type { CSSProperties } from "react";
import type {
  AlignedHotspotV1,
  PagePlanV1,
  TextAnchorV1,
  TextBlockV1,
} from "@openflipbook/config";
import { citationNumbers } from "@/lib/citation-utils";
import { formatUi, getStrings, type LocaleStrings } from "@/lib/i18n";

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
  onHotspotActivate?: (hotspotId: string) => void;
  t?: LocaleStrings;
}

interface HotspotLabelLayout {
  left: number;
  top: number;
  transform: string;
}

function clampUnit(value: number): number {
  return Math.min(0.97, Math.max(0.03, value));
}

function labelApproxWidth(label: string): number {
  return Math.min(0.36, Math.max(0.14, 0.08 + label.length * 0.018));
}

function boxesOverlap(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left &&
    a.top < b.top + b.height && a.top + a.height > b.top;
}

/** Compact, collision-aware label anchors around the aligned object boxes. */
export function hotspotLabelLayout(
  pagePlan: PagePlanV1,
  alignedHotspots: readonly AlignedHotspotV1[],
): Map<string, HotspotLabelLayout> {
  const planned = new Map(pagePlan.hotspots.map((hotspot) => [hotspot.id, hotspot] as const));
  const used: { left: number; top: number; width: number; height: number }[] = [];
  const layouts = new Map<string, HotspotLabelLayout>();
  const rows = alignedHotspots
    .map((aligned) => ({ aligned, planned: planned.get(aligned.id) }))
    .filter((row): row is { aligned: AlignedHotspotV1; planned: PagePlanV1["hotspots"][number] } =>
      Boolean(row.planned?.label.trim()),
    )
    .sort((a, b) => a.aligned.actual_bbox[1] - b.aligned.actual_bbox[1] || a.aligned.id.localeCompare(b.aligned.id));

  for (const [index, row] of rows.entries()) {
    const [x, y, w, h] = row.aligned.actual_bbox;
    const width = labelApproxWidth(row.planned.label);
    const height = 0.065;
    const centerX = clampUnit(x + w / 2);
    const centerY = clampUnit(y + h / 2);
    const candidates = [
      { left: centerX, top: clampUnit(y + h + 0.018), transform: "translate(-50%, 0)" },
      { left: centerX, top: clampUnit(y - 0.018), transform: "translate(-50%, -100%)" },
      { left: clampUnit(x + w + 0.018), top: centerY, transform: "translate(0, -50%)" },
      { left: clampUnit(x - 0.018), top: centerY, transform: "translate(-100%, -50%)" },
    ];
    const chosen = candidates.find((candidate) => {
      const left = candidate.transform.includes("-100%") ? candidate.left - width :
        candidate.transform.includes("-50%") ? candidate.left - width / 2 : candidate.left;
      const top = candidate.transform.includes("-100%") ? candidate.top - height :
        candidate.transform.includes("-50%") ? candidate.top - height / 2 : candidate.top;
      const box = { left, top, width, height };
      return !used.some((other) => boxesOverlap(box, other));
    }) ?? {
      left: centerX,
      top: clampUnit(y + h + 0.018 + (index % 4) * 0.07),
      transform: "translate(-50%, 0)",
    };
    const left = chosen.transform.includes("-100%") ? chosen.left - width :
      chosen.transform.includes("-50%") ? chosen.left - width / 2 : chosen.left;
    const top = chosen.transform.includes("-100%") ? chosen.top - height :
      chosen.transform.includes("-50%") ? chosen.top - height / 2 : chosen.top;
    used.push({ left, top, width, height });
    layouts.set(row.aligned.id, chosen);
  }
  return layouts;
}

export function PageContractOverlay({
  pagePlan,
  alignedHotspots = [],
  imageRect,
  showHotspots = false,
  onHotspotActivate,
  t = getStrings("en"),
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
          <span className="pointer-events-auto max-w-full cursor-text select-text overflow-wrap-anywhere rounded-md bg-[color:rgba(250,248,240,.86)] px-[clamp(.4rem,1.4vw,.7rem)] py-[clamp(.25rem,.9vw,.45rem)] text-[var(--color-ink)] shadow-sm backdrop-blur-[2px]">
            {block.text}
            {citationNumbers(block, pagePlan.sources).map((number) => (
              <sup
                key={`${block.id}-source-${number}`}
                data-source-marker={number}
                className="ms-0.5 align-super text-[.68em] font-semibold text-[var(--color-ink)]/75"
                aria-label={formatUi(t.sourceNumber, { number })}
              >
                [{number}]
              </sup>
            ))}
          </span>
        </div>
      ))}

      {showHotspots && (() => {
        const layouts = hotspotLabelLayout(pagePlan, alignedHotspots);
        return alignedHotspots.map((hotspot) => {
          const planned = pagePlan.hotspots.find((candidate) => candidate.id === hotspot.id);
          const layout = layouts.get(hotspot.id);
          if (!planned || !layout || !planned.label.trim()) return null;
          return (
            <button
              key={hotspot.id}
              type="button"
              data-hotspot-label="true"
              data-hotspot-id={hotspot.id}
              aria-label={planned.label}
              title={planned.label}
              onClick={(event) => {
                event.stopPropagation();
                onHotspotActivate?.(hotspot.id);
              }}
              className="pointer-events-auto absolute z-[1] max-w-[36%] -translate-y-0 rounded-md border border-amber-200/80 bg-black/75 px-2 py-1 text-left text-[clamp(.68rem,1.45vw,.95rem)] font-medium leading-tight text-white shadow-md backdrop-blur-sm hover:bg-black/90 focus:outline-none focus:ring-2 focus:ring-amber-300"
              style={{
                left: `${layout.left * 100}%`,
                top: `${layout.top * 100}%`,
                transform: layout.transform,
              }}
            >
              {planned.label}
            </button>
          );
        });
      })()}
    </div>
  );
}

export default PageContractOverlay;
