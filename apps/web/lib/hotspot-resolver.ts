import type {
  AlignedHotspotV1,
  PagePlanV1,
  PlannedHotspotV1,
} from "@openflipbook/config";

export type HotspotResolutionMethod =
  | "tap_region"
  | "bbox"
  | "planned_fallback"
  | "nearest";

export type HotspotGeometrySource = "aligned" | "planned_fallback";

export interface CanonicalHotspotRowV1 {
  planned: PlannedHotspotV1;
  aligned: AlignedHotspotV1;
  geometry_source: HotspotGeometrySource;
}

export interface HotspotHitV1 {
  planned: PlannedHotspotV1;
  aligned: AlignedHotspotV1;
  method: HotspotResolutionMethod;
  geometry_source: HotspotGeometrySource;
}

/** The single deterministic semantic intent shared by label and pixel taps. */
export interface HotspotIntentV1 {
  hotspot_id: string;
  label: string;
  sub_query: string;
  visual_target: string;
  activation_point: { x_pct: number; y_pct: number };
  aligned_bbox: AlignedHotspotV1["actual_bbox"];
  tap_region: AlignedHotspotV1["tap_region"];
  alignment_confidence: number;
  method: HotspotResolutionMethod;
  geometry_source: HotspotGeometrySource;
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

function fallbackTapRegion(
  bbox: PlannedHotspotV1["desired_bbox"],
): AlignedHotspotV1["tap_region"] {
  const [x, y, width, height] = bbox;
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
}

/** Build one geometry row for every planned hotspot, including legacy fallback rows. */
export function canonicalHotspotRows(
  pagePlan: PagePlanV1,
  aligned: readonly AlignedHotspotV1[],
): CanonicalHotspotRowV1[] {
  const alignedById = new Map(aligned.map((row) => [row.id, row] as const));
  return pagePlan.hotspots.map((planned) => {
    const alignedRow = alignedById.get(planned.id);
    if (alignedRow) {
      return {
        planned,
        aligned: alignedRow,
        geometry_source: "aligned",
      };
    }
    return {
      planned,
      aligned: {
        id: planned.id,
        actual_bbox: planned.desired_bbox,
        tap_region: fallbackTapRegion(planned.desired_bbox),
        alignment_confidence: 0,
      },
      geometry_source: "planned_fallback",
    };
  });
}

function stableConfidenceOrder(
  a: CanonicalHotspotRowV1,
  b: CanonicalHotspotRowV1,
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
  const rows = canonicalHotspotRows(pagePlan, aligned);
  const alignedRows = rows.filter((row) => row.geometry_source === "aligned");
  const fallbackRows = rows.filter((row) => row.geometry_source === "planned_fallback");

  const region = alignedRows
    .filter((r) => pointInPolygon(x, y, r.aligned.tap_region))
    .sort(stableConfidenceOrder)[0];
  if (region) return { ...region, method: "tap_region" };

  const bbox = alignedRows
    .filter((r) => bboxContains(r.aligned.actual_bbox, x, y))
    .sort(stableConfidenceOrder)[0];
  if (bbox) return { ...bbox, method: "bbox" };

  const fallback = fallbackRows
    .filter((r) => bboxContains(r.aligned.actual_bbox, x, y))
    .sort(stableConfidenceOrder)[0];
  if (fallback) return { ...fallback, method: "planned_fallback" };

  const nearest = [...rows].sort((a, b) => {
    const da = centerDistance2(a.aligned.actual_bbox, x, y);
    const db = centerDistance2(b.aligned.actual_bbox, x, y);
    return da - db || stableConfidenceOrder(a, b);
  })[0]!;
  return { ...nearest, method: "nearest" };
}

function activationPoint(aligned: AlignedHotspotV1): { x_pct: number; y_pct: number } {
  const [x, y, w, h] = aligned.actual_bbox;
  return {
    x_pct: Math.min(1, Math.max(0, x + w / 2)),
    y_pct: Math.min(1, Math.max(0, y + h / 2)),
  };
}

function intentFromHit(
  hit: HotspotHitV1,
  point: { x_pct: number; y_pct: number },
): HotspotIntentV1 | null {
  const subQuery = hit.planned.sub_query.trim();
  if (!subQuery) return null;
  return {
    hotspot_id: hit.planned.id,
    label: hit.planned.label,
    sub_query: subQuery,
    visual_target: hit.planned.visual_target,
    activation_point: point,
    aligned_bbox: hit.aligned.actual_bbox,
    tap_region: hit.aligned.tap_region,
    alignment_confidence: hit.aligned.alignment_confidence,
    method: hit.method,
    geometry_source: hit.geometry_source,
  };
}

/** Resolve a DOM label by its id. Never falls back to a neighboring hotspot. */
export function hotspotIntentById(
  pagePlan: PagePlanV1,
  aligned: readonly AlignedHotspotV1[],
  hotspotId: string,
): HotspotIntentV1 | null {
  const row = canonicalHotspotRows(pagePlan, aligned).find(
    (candidate) => candidate.planned.id === hotspotId,
  );
  if (!row) return null;
  return intentFromHit(
    {
      ...row,
      method: row.geometry_source === "aligned" ? "bbox" : "planned_fallback",
    },
    activationPoint(row.aligned),
  );
}

/** Resolve a geometric image point into the same canonical semantic intent. */
export function hotspotIntentAtPoint(
  pagePlan: PagePlanV1,
  aligned: readonly AlignedHotspotV1[],
  x: number,
  y: number,
): HotspotIntentV1 | null {
  const hit = resolveHotspot(pagePlan, aligned, x, y);
  return hit ? intentFromHit(hit, { x_pct: x, y_pct: y }) : null;
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

export function deterministicTapPrefetchFromIntent(intent: HotspotIntentV1) {
  return {
    subject: intent.label,
    style: "",
    subject_context: intent.sub_query,
    groundable: true,
    confidence: intent.alignment_confidence,
  } as const;
}
