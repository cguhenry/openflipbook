export interface SessionNodeLike {
  id: string;
  parent_id?: string | null;
  created_at?: string | null;
}

export interface SessionGraph {
  roots: string[];
  children: Map<string, string[]>;
  parent: Map<string, string>;
  branchPoints: Set<string>;
}

export function buildSessionGraph(nodes: readonly SessionNodeLike[]): SessionGraph {
  const by = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
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
  return { roots, children, parent, branchPoints };
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
