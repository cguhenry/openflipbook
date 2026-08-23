import type {
  AlignedHotspotV1,
  PagePlanV1,
  SourceRefV1,
} from "@openflipbook/config";
import { resolveHotspot } from "@/lib/hotspot-resolver";

export interface OfflineSourceNode {
  id: string;
  parent_id?: string | null;
  source_hotspot_id?: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_asset: string;
  aspect_ratio?: string | null;
  click_in_parent?: { x_pct: number; y_pct: number } | null;
  sources?: Array<{
    id?: string;
    url: string;
    title: string | null;
    snippet?: string;
    engine?: string | null;
  }> | null;
  page_plan?: PagePlanV1 | null;
  aligned_hotspots?: AlignedHotspotV1[] | null;
  created_at?: string | null;
}

export interface PortableTextBlock {
  id: string;
  role: string;
  text: string;
  anchor: string;
  source_ids: string[];
}

export interface PortableSource extends SourceRefV1 {
  engine?: string | null;
}

export interface PortableHotspot {
  id: string;
  label: string;
  sub_query: string;
  actual_bbox: [number, number, number, number];
  tap_region: [number, number][];
  target_node_id: string | null;
}

export interface PortableNode {
  id: string;
  parent_id: string | null;
  source_hotspot_id: string | null;
  title: string;
  query: string;
  image: string;
  aspect_ratio: string;
  text_blocks: PortableTextBlock[];
  sources: PortableSource[];
  hotspots: PortableHotspot[];
  created_at: string;
}

export interface PortableBookV1 {
  schema_version: "1.0";
  session_id: string;
  root_node_id: string;
  nodes: PortableNode[];
}

function epoch(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ordered(nodes: readonly OfflineSourceNode[]): OfflineSourceNode[] {
  return [...nodes].sort(
    (a, b) => epoch(a.created_at) - epoch(b.created_at) || a.id.localeCompare(b.id),
  );
}

function rootId(nodes: readonly OfflineSourceNode[]): string {
  const roots = nodes.filter((node) => !node.parent_id);
  return (roots[0] ?? nodes[0])?.id ?? "";
}

function portableSources(
  node: OfflineSourceNode,
  plan: PagePlanV1 | null,
): PortableSource[] {
  const rows = plan?.sources ?? node.sources ?? [];
  return rows.slice(0, 5).map((source, index) => ({
    id: source.id ?? `S${index + 1}`,
    title: source.title ?? "",
    url: source.url,
    snippet: source.snippet ?? "",
    ...("engine" in source ? { engine: source.engine ?? null } : {}),
  }));
}

/**
 * Build a file://-portable book manifest from persisted session rows.
 *
 * Explicit source_hotspot_id is the semantic edge contract. Legacy rows without
 * it are recovered deterministically from click_in_parent against the parent
 * contract. When the same edge was explored more than once, the newest child
 * becomes the default click target while every node remains present in nodes.
 */
export function buildPortableBook(
  sourceNodes: readonly OfflineSourceNode[],
): PortableBookV1 {
  if (sourceNodes.length === 0) {
    throw new Error("cannot export an empty session");
  }

  const rows = ordered(sourceNodes);
  const byId = new Map(rows.map((node) => [node.id, node] as const));
  const childLink = new Map<string, { childId: string; created: number }>();
  const explicitEdgeKeys = new Set<string>();

  const rememberNewest = (key: string, childId: string, created: number) => {
    const previous = childLink.get(key);
    if (!previous || created >= previous.created) {
      childLink.set(key, { childId, created });
    }
  };

  // First register every explicit key, including invalid ones, so a malformed
  // explicit edge can never be silently replaced by coordinate inference.
  for (const child of rows) {
    if (!child.parent_id || child.source_hotspot_id == null) continue;
    const key = child.parent_id + ":" + child.source_hotspot_id;
    explicitEdgeKeys.add(key);
    const parent = byId.get(child.parent_id);
    const hasPlanned = Boolean(
      parent?.page_plan?.hotspots.some(
        (hotspot) => hotspot.id === child.source_hotspot_id,
      ),
    );
    const hasAligned = Boolean(
      parent?.aligned_hotspots?.some(
        (hotspot) => hotspot.id === child.source_hotspot_id,
      ),
    );
    if (hasPlanned && hasAligned) {
      rememberNewest(key, child.id, epoch(child.created_at));
    }
  }

  for (const child of rows) {
    if (
      !child.parent_id ||
      child.source_hotspot_id != null ||
      !child.click_in_parent
    ) continue;
    const parent = byId.get(child.parent_id);
    if (!parent?.page_plan || !parent.aligned_hotspots?.length) continue;

    const hit = resolveHotspot(
      parent.page_plan,
      parent.aligned_hotspots,
      child.click_in_parent.x_pct,
      child.click_in_parent.y_pct,
    );
    if (!hit) continue;

    const key = parent.id + ":" + hit.planned.id;
    if (explicitEdgeKeys.has(key)) continue;
    const created = epoch(child.created_at);
    rememberNewest(key, child.id, created);
  }

  const nodes: PortableNode[] = rows.map((node) => {
    const plan = node.page_plan ?? null;
    const alignedById = new Map(
      (node.aligned_hotspots ?? []).map((hotspot) => [hotspot.id, hotspot] as const),
    );

    const hotspots: PortableHotspot[] = (plan?.hotspots ?? []).flatMap((planned) => {
      const aligned = alignedById.get(planned.id);
      if (!aligned) return [];
      return [{
        id: planned.id,
        label: planned.label,
        sub_query: planned.sub_query,
        actual_bbox: [...aligned.actual_bbox] as [number, number, number, number],
        tap_region: aligned.tap_region.map(([x, y]) => [x, y] as [number, number]),
        target_node_id: childLink.get(node.id + ":" + planned.id)?.childId ?? null,
      }];
    });

    return {
      id: node.id,
      parent_id: node.parent_id ?? null,
      source_hotspot_id: node.source_hotspot_id ?? null,
      title: node.page_title,
      query: node.query,
      image: node.image_asset,
      aspect_ratio: node.aspect_ratio || "16:9",
      text_blocks: (plan?.text_blocks ?? []).map((block) => ({
        id: block.id,
        role: block.role,
        text: block.text,
        anchor: block.anchor,
        source_ids: block.source_ids ?? [],
      })),
      sources: portableSources(node, plan),
      hotspots,
      created_at: node.created_at ?? "",
    };
  });

  return {
    schema_version: "1.0",
    session_id: rows[0]!.session_id,
    root_node_id: rootId(rows),
    nodes,
  };
}

export function portableBookScript(book: PortableBookV1): string {
  const json = JSON.stringify(book)
    .replaceAll("</script", "<\\/script")
    .replaceAll("<!--", "<\\!--");
  return "window.OPENFLIPBOOK_OFFLINE_BOOK=" + json + ";\n";
}
