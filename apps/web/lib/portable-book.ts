import type { AlignedHotspotV1, PagePlanV1 } from "@openflipbook/config";
import { resolveHotspot } from "@/lib/hotspot-resolver";

export interface OfflineSourceNode {
  id: string;
  parent_id?: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_asset: string;
  aspect_ratio?: string | null;
  click_in_parent?: { x_pct: number; y_pct: number } | null;
  page_plan?: PagePlanV1 | null;
  aligned_hotspots?: AlignedHotspotV1[] | null;
  created_at?: string | null;
}

export interface PortableTextBlock {
  id: string;
  role: string;
  text: string;
  anchor: string;
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
  title: string;
  query: string;
  image: string;
  aspect_ratio: string;
  text_blocks: PortableTextBlock[];
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

/**
 * Build a file://-portable book manifest from persisted session rows.
 *
 * A2 does not persist source_hotspot_id, so child-to-hotspot links are recovered
 * deterministically from the child's click_in_parent against the parent contract.
 * When the same hotspot was explored more than once, the newest child becomes
 * the default click target while every node remains present in nodes.
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

  for (const child of rows) {
    if (!child.parent_id || !child.click_in_parent) continue;
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
    const created = epoch(child.created_at);
    const previous = childLink.get(key);
    if (!previous || created >= previous.created) {
      childLink.set(key, { childId: child.id, created });
    }
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
      title: node.page_title,
      query: node.query,
      image: node.image_asset,
      aspect_ratio: node.aspect_ratio || "16:9",
      text_blocks: (plan?.text_blocks ?? []).map((block) => ({
        id: block.id,
        role: block.role,
        text: block.text,
        anchor: block.anchor,
      })),
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
