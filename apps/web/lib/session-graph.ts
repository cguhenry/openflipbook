export interface SessionNodeLike {
  id: string;
  parent_id?: string | null;
  source_hotspot_id?: string | null;
  created_at?: string | null;
}

export interface SessionGraph {
  roots: string[];
  children: Map<string, string[]>;
  parent: Map<string, string>;
  // Explicit semantic edges. A historical duplicate edge resolves to the
  // newest child by created_at/id, while legacy coordinate-only rows stay out
  // of this map and continue through the fallback resolver.
  explicitEdges: Map<string, string>;
  branchPoints: Set<string>;
}

export function explicitEdgeKey(parentId: string, sourceHotspotId: string): string {
  return `${parentId}\u0000${sourceHotspotId}`;
}

export function buildSessionGraph(nodes: readonly SessionNodeLike[]): SessionGraph {
  const by = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const explicitEdges = new Map<string, string>();
  const roots: string[] = [];
  const compare = (a: string, b: string) =>
    (by.get(a)?.created_at ?? "").localeCompare(by.get(b)?.created_at ?? "") ||
    a.localeCompare(b);

  for (const node of nodes) {
    const parentId = node.parent_id ?? null;
    if (!parentId || !by.has(parentId)) {
      roots.push(node.id);
      continue;
    }
    parent.set(node.id, parentId);
    const siblings = children.get(parentId) ?? [];
    siblings.push(node.id);
    children.set(parentId, siblings);

    if (node.source_hotspot_id !== undefined && node.source_hotspot_id !== null) {
      const key = explicitEdgeKey(parentId, node.source_hotspot_id);
      const previousId = explicitEdges.get(key);
      if (!previousId || compare(node.id, previousId) >= 0) {
        explicitEdges.set(key, node.id);
      }
    }
  }
  roots.sort(compare);
  for (const [parentId, ids] of children) {
    ids.sort(compare);
    children.set(parentId, ids);
  }
  const branchPoints = new Set<string>();
  for (const [parentId, ids] of children) {
    if (ids.length > 1) branchPoints.add(parentId);
  }
  return { roots, children, parent, explicitEdges, branchPoints };
}

/** Return the persisted child for one semantic hotspot edge, if present. */
export function findExplicitChild(
  nodes: readonly SessionNodeLike[],
  parentId: string,
  sourceHotspotId: string,
): string | null {
  return buildSessionGraph(nodes).explicitEdges.get(
    explicitEdgeKey(parentId, sourceHotspotId),
  ) ?? null;
}

export function ancestryTrail(currentId: string, graph: SessionGraph): string[] {
  const out = [currentId];
  const seen = new Set(out);
  let cursor = currentId;
  while (graph.parent.has(cursor)) {
    cursor = graph.parent.get(cursor)!;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    out.push(cursor);
  }
  return out.reverse();
}
