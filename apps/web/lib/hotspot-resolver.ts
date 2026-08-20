import type {
  AlignedHotspotV1,
  PagePlanV1,
  PlannedHotspotV1,
} from "@openflipbook/config";

export type HotspotResolutionMethod = "tap_region" | "bbox" | "nearest";

export interface HotspotHitV1 {
  planned: PlannedHotspotV1;
  aligned: AlignedHotspotV1;
  method: HotspotResolutionMethod;
}

const EPS = 1e-9;

function inUnit(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

function pointOnSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > EPS) return false;
  const dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay);
  if (dot < -EPS) return false;
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  return dot <= len2 + EPS;
}

export function pointInPolygon(
  x: number,
  y: number,
  polygon: readonly (readonly [number, number])[],
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (pointOnSegment(x, y, xi, yi, xj, yj)) return true;
    const crosses = yi > y !== yj > y;
    if (crosses) {
      const xAtY = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xAtY) inside = !inside;
    }
  }
  return inside;
}

function bboxContains(
  bbox: readonly [number, number, number, number],
  x: number,
  y: number,
): boolean {
  const [bx, by, bw, bh] = bbox;
  return x + EPS >= bx && y + EPS >= by && x <= bx + bw + EPS && y <= by + bh + EPS;
}

function centerDistance2(
  bbox: readonly [number, number, number, number],
  x: number,
  y: number,
): number {
  const [bx, by, bw, bh] = bbox;
  const dx = x - (bx + bw / 2);
  const dy = y - (by + bh / 2);
  return dx * dx + dy * dy;
}

function candidateRows(pagePlan: PagePlanV1, aligned: readonly AlignedHotspotV1[]) {
  const planned = new Map(pagePlan.hotspots.map((h) => [h.id, h] as const));
  return aligned
    .map((a) => ({ aligned: a, planned: planned.get(a.id) }))
    .filter((row): row is { aligned: AlignedHotspotV1; planned: PlannedHotspotV1 } => Boolean(row.planned));
}

function stableConfidenceOrder(
  a: { aligned: AlignedHotspotV1 },
  b: { aligned: AlignedHotspotV1 },
): number {
  return (
    b.aligned.alignment_confidence - a.aligned.alignment_confidence ||
    a.aligned.id.localeCompare(b.aligned.id)
  );
}

/** Resolve an in-image point without a model call. */
export function resolveHotspot(
  pagePlan: PagePlanV1,
  aligned: readonly AlignedHotspotV1[],
  x: number,
  y: number,
): HotspotHitV1 | null {
  if (!inUnit(x) || !inUnit(y)) return null;
  const rows = candidateRows(pagePlan, aligned);
  if (rows.length === 0) return null;

  const region = rows
    .filter((r) => pointInPolygon(x, y, r.aligned.tap_region))
    .sort(stableConfidenceOrder)[0];
  if (region) return { ...region, method: "tap_region" };

  const bbox = rows
    .filter((r) => bboxContains(r.aligned.actual_bbox, x, y))
    .sort(stableConfidenceOrder)[0];
  if (bbox) return { ...bbox, method: "bbox" };

  const nearest = [...rows].sort((a, b) => {
    const da = centerDistance2(a.aligned.actual_bbox, x, y);
    const db = centerDistance2(b.aligned.actual_bbox, x, y);
    return da - db || stableConfidenceOrder(a, b);
  })[0]!;
  return { ...nearest, method: "nearest" };
}

/** Fields already understood by the existing warm tap pipeline. */
export function deterministicTapPrefetch(hit: HotspotHitV1) {
  return {
    subject: hit.planned.label,
    style: "",
    subject_context: hit.planned.sub_query,
    groundable: true,
    confidence: hit.aligned.alignment_confidence,
  } as const;
}
