// Reference shared types for the NAS interactive-page contract.
// Keep wire names aligned with apps/modal-backend/contracts/page_contract.py.

export const PAGE_CONTRACT_VERSION = "1.0" as const;

export type NormBBox = readonly [number, number, number, number];
export type NormPoint = readonly [number, number];

export interface SourceRefV1 {
  /** Stable local grounding id (S1..S5); optional for legacy pages. */
  id?: string;
  title: string;
  url: string;
  snippet: string;
}

export type AspectRatioV1 = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

export interface SceneSpecV1 {
  prompt: string;
  style: string;
  aspect_ratio: AspectRatioV1;
}

export type TextRoleV1 = "title" | "subtitle" | "body" | "callout" | "caption" | "source";
export type TextAnchorV1 =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";

export interface TextBlockV1 {
  id: string;
  role: TextRoleV1;
  text: string;
  anchor: TextAnchorV1;
  /** Local source ids only; URLs live in PagePlanV1.sources. */
  source_ids?: string[];
}

export interface PlannedHotspotV1 {
  id: string;
  label: string;
  sub_query: string;
  visual_target: string;
  desired_bbox: NormBBox;
}

export type MotionEffectV1 = "none" | "pulse" | "drift-up" | "rotate" | "parallax" | "ken-burns" | "glow";

export interface MotionHintV1 {
  target_hotspot_id: string | null;
  effect: MotionEffectV1;
  intensity: number;
}

export interface PagePlanV1 {
  schema_version: typeof PAGE_CONTRACT_VERSION;
  title: string;
  summary: string;
  scene: SceneSpecV1;
  text_blocks: TextBlockV1[];
  hotspots: PlannedHotspotV1[];
  motion_hints: MotionHintV1[];
  sources: SourceRefV1[];
}

export interface ImageAssetV1 {
  asset_key: string;
  width: number;
  height: number;
  provider: string;
  model: string;
}

export interface AlignedHotspotV1 {
  id: string;
  actual_bbox: NormBBox;
  tap_region: NormPoint[];
  alignment_confidence: number;
}

export interface RenderedPageV1 {
  schema_version: typeof PAGE_CONTRACT_VERSION;
  node_id: string;
  page_plan: PagePlanV1;
  image: ImageAssetV1;
  hotspots: AlignedHotspotV1[];
}
