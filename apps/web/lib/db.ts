import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import type {
  AlignedHotspotV1,
  PagePlanV1,
  ScaleTier,
  SceneView,
  ViewSpec,
} from "@openflipbook/config";
import { readServerEnv, requireMongo } from "./env";

declare global {
  // Singleton pool sentinel. Both `lib/db.ts` and `lib/world.ts` share this
  // — they MUST go through `getDb()` here so the index-init runs exactly
  // once per Node worker regardless of which module gets called first on a
  // cold start. Earlier we had two duplicate sentinels; whichever module
  // won the race would skip the other's index init.
  var __endlessCanvasMongo: { client: MongoClient; db: Db } | undefined;
  // In-flight bootstrap promise. Memoised so concurrent first callers
  // (e.g. two parallel SSE routes hitting the worker right after cold
  // start) share one client + one ensureIndexes call. Without this the
  // un-memoised `if (!globalThis.__endlessCanvasMongo) connect()` opens
  // two MongoClients per worker and runs ensureIndexes twice on the same
  // collection.
  var __endlessCanvasMongoBootstrap: Promise<Db> | undefined;
}

/** Shared Mongo handle. Lazily connects, registers indexes once. */
export async function getDb(): Promise<Db> {
  if (globalThis.__endlessCanvasMongo) {
    return globalThis.__endlessCanvasMongo.db;
  }
  if (globalThis.__endlessCanvasMongoBootstrap) {
    return globalThis.__endlessCanvasMongoBootstrap;
  }
  const bootstrap = (async () => {
    const cfg = requireMongo(readServerEnv());
    const client = new MongoClient(cfg.uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    const db = client.db(cfg.db);
    await ensureIndexes(db);
    globalThis.__endlessCanvasMongo = { client, db };
    return db;
  })();
  globalThis.__endlessCanvasMongoBootstrap = bootstrap;
  try {
    return await bootstrap;
  } finally {
    // Once settled, drop the in-flight memo so a later transient failure
    // (e.g. process recovers from a network blip) can retry. The
    // happy-path returns above via `__endlessCanvasMongo` and never
    // hits this branch again.
    globalThis.__endlessCanvasMongoBootstrap = undefined;
  }
}

/** Client paired with getDb(), for the owner-restore multi-collection transaction. */
export async function getMongoClient(): Promise<MongoClient> {
  await getDb();
  const current = globalThis.__endlessCanvasMongo;
  if (!current) throw new Error("Mongo client unavailable after bootstrap");
  return current.client;
}

/** Read-only liveness probe used by core readiness. */
export async function pingMongo(): Promise<void> {
  const db = await getDb();
  await db.command({ ping: 1 }, { timeoutMS: 3_000 });
}

async function ensureIndexes(db: Db): Promise<void> {
  const nodes = db.collection<NodeDoc>("nodes");
  const errors = db.collection<ErrorDoc>("errors");
  const world = db.collection("world_state");
  // Geometric world model — per-session map of entity coordinates. `_id` is the
  // session id (auto-indexed); the sparse secondary index supports atlas anchor
  // lookups that link a map entity back to its Codex Entity. Created up front so
  // we don't migrate a populated collection later.
  const worldMap = db.collection("world_map");
  // Shared-session presence heartbeats expire on their own (TTL); the live
  // viewer count uses a tighter window on top.
  const presenceCol = db.collection("session_presence");
  await Promise.all([
    presenceCol.createIndex(
      { last_seen: 1 },
      { name: "presence_ttl_idx", expireAfterSeconds: 120 }
    ),
    nodes.createIndex(
      { session_id: 1, created_at: -1 },
      { name: "session_created_idx" }
    ),
    nodes.createIndex({ parent_id: 1 }, { name: "parent_idx" }),
    nodes.createIndex(
      { parent_id: 1, created_at: -1 },
      { name: "parent_created_idx" }
    ),
    errors.createIndex({ ts: -1 }, { name: "errors_ts_idx" }),
    // World-memory layer. `_id` is the session id (auto-indexed). The secondary
    // index supports atlas-overlay queries; created eagerly to avoid migrating a
    // populated collection later.
    world.createIndex(
      { "entities.appears_on_node_ids": 1 },
      { name: "world_entity_appears_idx", sparse: true }
    ),
    worldMap.createIndex(
      { "entities.entity_id": 1 },
      { name: "world_map_entity_idx", sparse: true }
    ),
  ]);
}

async function nodes(): Promise<Collection<NodeDoc>> {
  return (await getDb()).collection<NodeDoc>("nodes");
}

export interface ClickInParent {
  x_pct: number;
  y_pct: number;
}

export interface NodeSource {
  id?: string;
  url: string;
  title: string | null;
  snippet?: string;
  engine?: string | null;
}

export interface NodeDoc extends Document {
  _id: string;
  parent_id: string | null;
  // Explicit semantic edge provenance. Optional on legacy Mongo rows; roots
  // and legacy children normalize to null at the read boundary.
  source_hotspot_id?: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_key: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string | null;
  click_in_parent: ClickInParent | null;
  // Web-search citations the planner used. Backwards-compatible: missing on
  // pre-citations nodes and treated as []. Canonical source ids/snippets are
  // additive for B2 pages.
  sources?: NodeSource[] | null;
  // M3 scale-space: how this node relates to its parent ("descend" = tap-in /
  // default, "expand" = bloomed neighbour, "ascend" = OUTWARD container) + its
  // size vs the parent's focal subject. Optional + defaulted for back-compat.
  relation?: "descend" | "expand" | "ascend" | "edit" | null;
  scale?: "component" | "peer" | "container" | null;
  // B2 scale ladder: the coarse absolute rung this node's frame sits at.
  // Optional + null for pre-B2 rows.
  scale_tier?: ScaleTier | null;
  // Geometric world (GEOMETRIC_WORLD): the observer pose + view level this
  // scene was rendered from. Optional + null for pre-geometry / classic nodes.
  scene_view?: SceneView | null;
  // A2 Page Contract metadata. Optional on the document for old Mongo rows.
  page_plan?: PagePlanV1 | null;
  aligned_hotspots?: AlignedHotspotV1[] | null;
  seed_type?: "image" | null;
  // When entity extraction last RAN for this node (set even if it found zero
  // entities). Durable "already extracted" marker so a later revisit / reload
  // never silently re-runs the non-deterministic VLM pass. Absent on legacy
  // rows → treated as "not yet extracted".
  geo_extracted_at?: Date | null;
  created_at: Date;
}

export interface NodeInsert {
  // Optional caller-supplied id (default: a fresh UUID). Lets the OUTWARD reparent
  // build the new parent's self-referential scene_view.node_id before inserting.
  id?: string;
  parent_id: string | null;
  source_hotspot_id?: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_key: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string | null;
  click_in_parent?: ClickInParent | null;
  sources?: NodeSource[] | null;
  relation?: "descend" | "expand" | "ascend" | "edit" | null;
  scale?: "component" | "peer" | "container" | null;
  scale_tier?: ScaleTier | null;
  scene_view?: SceneView | null;
  page_plan?: PagePlanV1 | null;
  aligned_hotspots?: AlignedHotspotV1[] | null;
  seed_type?: "image" | null;
}

export interface NodeRow {
  id: string;
  parent_id: string | null;
  source_hotspot_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_key: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string | null;
  click_in_parent: ClickInParent | null;
  sources: NodeSource[];
  relation: "descend" | "expand" | "ascend" | "edit";
  scale: "component" | "peer" | "container";
  scale_tier: ScaleTier | null;
  page_plan: PagePlanV1 | null;
  aligned_hotspots: AlignedHotspotV1[] | null;
  seed_type: "image" | null;
  // The observer pose + view level this node was rendered from. Null on
  // pre-geometry / classic nodes. Read back on revisit so the minimap scopes to
  // the right frame and the entered angle is reproducible.
  scene_view: SceneView | null;
  // Whether entity extraction has already run for this node. Read back on
  // revisit so the client never auto-re-extracts a node it has already done.
  geo_extracted: boolean;
  created_at: string;
}

export function toRow(doc: NodeDoc): NodeRow {
  const {
    _id,
    created_at,
    click_in_parent,
    source_hotspot_id,
    sources,
    relation,
    scale,
    scale_tier,
    scene_view,
    page_plan,
    aligned_hotspots,
    seed_type,
    geo_extracted_at,
    ...rest
  } = doc;
  return {
    id: _id,
    ...rest,
    click_in_parent: click_in_parent ?? null,
    source_hotspot_id: source_hotspot_id ?? null,
    sources: Array.isArray(sources) ? sources : [],
    relation: relation ?? "descend",
    scale: scale ?? "peer",
    scale_tier: scale_tier ?? null,
    scene_view: scene_view ?? null,
    page_plan: page_plan ?? null,
    aligned_hotspots: aligned_hotspots ?? null,
    seed_type: seed_type ?? null,
    geo_extracted: geo_extracted_at != null,
    created_at: created_at.toISOString(),
  };
}

export async function insertNode(n: NodeInsert): Promise<NodeRow> {
  const collection = await nodes();
  const doc: NodeDoc = {
    _id: n.id ?? crypto.randomUUID(),
    parent_id: n.parent_id,
    source_hotspot_id: n.source_hotspot_id ?? null,
    session_id: n.session_id,
    query: n.query,
    page_title: n.page_title,
    image_key: n.image_key,
    image_model: n.image_model,
    prompt_author_model: n.prompt_author_model,
    aspect_ratio: n.aspect_ratio,
    final_prompt: n.final_prompt,
    click_in_parent: n.click_in_parent ?? null,
    sources: n.sources ?? null,
    relation: n.relation ?? "descend",
    scale: n.scale ?? "peer",
    scale_tier: n.scale_tier ?? null,
    scene_view: n.scene_view ?? null,
    page_plan: n.page_plan ?? null,
    aligned_hotspots: n.aligned_hotspots ?? null,
    seed_type: n.seed_type ?? null,
    created_at: new Date(),
  };
  await collection.insertOne(doc);
  return toRow(doc);
}

export async function getNode(id: string): Promise<NodeRow | null> {
  const collection = await nodes();
  const doc = await collection.findOne({ _id: id });
  return doc ? toRow(doc) : null;
}

/** Re-root a CURRENT ROOT under a synthesized parent — the ONLY mutate path on the
 *  nodes collection, for the OUTWARD reparent. A single-field `$set` on one doc,
 *  atomic in Mongo, **guarded on `parent_id: null`** so it only ever re-points a
 *  root: a concurrent double-ascend that already re-rooted this node loses the race
 *  (`matchedCount === 0`) instead of stacking a second parent. Returns whether it
 *  matched. Deliberately narrow (parent_id only) so it can't rewrite arbitrary
 *  topology or invert an interior edge. */
export async function updateNodeParent(id: string, parentId: string | null): Promise<boolean> {
  const collection = await nodes();
  const res = await collection.updateOne(
    { _id: id, parent_id: null },
    { $set: { parent_id: parentId } },
  );
  return res.matchedCount === 1;
}

/** Delete a node by id — used only to roll back an orphaned parent P when an
 *  OUTWARD reparent aborts after inserting P but before re-pointing the child. */
export async function deleteNode(id: string): Promise<boolean> {
  const collection = await nodes();
  const res = await collection.deleteOne({ _id: id });
  return res.deletedCount === 1;
}

export interface ListNodesResult {
  rows: NodeRow[];
  next_cursor: string | null;
}

export async function listNodesByParent(
  parentId: string,
  opts: { limit?: number } = {}
): Promise<NodeRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const collection = await nodes();
  const docs = await collection
    .find({ parent_id: parentId })
    .sort({ created_at: 1, _id: 1 })
    .limit(limit)
    .toArray();
  return docs.map(toRow);
}

export async function listNodesBySession(
  sessionId: string,
  opts: { cursor?: string | null; limit?: number } = {}
): Promise<ListNodesResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const collection = await nodes();
  const filter: Record<string, unknown> = { session_id: sessionId };
  // Cursor format: "<iso_ts>|<_id>" — `_id` is a UUID tiebreaker so two
  // documents inserted within the same millisecond don't get skipped on
  // page boundaries. Old-format cursors (no pipe, ISO only) are accepted
  // for forward-compat; they fall back to the original $gt-on-timestamp
  // filter and may miss ms-tied rows.
  if (opts.cursor) {
    const [tsPart, idPart] = opts.cursor.split("|");
    const cursorDate = new Date(tsPart ?? opts.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      if (idPart) {
        filter.$or = [
          { created_at: { $gt: cursorDate } },
          { created_at: cursorDate, _id: { $gt: idPart } },
        ];
      } else {
        filter.created_at = { $gt: cursorDate };
      }
    }
  }
  const docs = await collection
    .find(filter)
    .sort({ created_at: 1, _id: 1 })
    .limit(limit)
    .toArray();
  const rows = docs.map(toRow);
  const lastDoc = docs[docs.length - 1];
  const next_cursor =
    docs.length === limit && lastDoc
      ? `${lastDoc.created_at.toISOString()}|${lastDoc._id}`
      : null;
  return { rows, next_cursor };
}

export interface SessionSummaryRow {
  session_id: string;
  root_node_id: string;
  latest_node_id: string;
  title: string;
  node_count: number;
  branch_count: number;
  updated_at: string;
  thumbnail_key: string;
  has_sources: boolean;
  has_image_seed: boolean;
}

/** Derive lightweight history cards from the existing node graph. */
export async function listSessionSummaries(limit = 30): Promise<SessionSummaryRow[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const docs = await (await nodes())
    .find({ session_id: { $type: "string" } })
    .sort({ created_at: -1, _id: 1 })
    .limit(5000)
    .toArray();
  const grouped = new Map<string, NodeRow[]>();
  for (const doc of docs) {
    const row = toRow(doc);
    const bucket = grouped.get(row.session_id) ?? [];
    bucket.push(row);
    grouped.set(row.session_id, bucket);
  }

  const summaries: SessionSummaryRow[] = [];
  for (const [sessionId, rows] of grouped) {
    if (rows.length === 0) continue;
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    const children = new Map<string, number>();
    const roots = rows.filter((row) => !row.parent_id || !byId.has(row.parent_id));
    for (const row of rows) {
      if (row.parent_id && byId.has(row.parent_id)) {
        children.set(row.parent_id, (children.get(row.parent_id) ?? 0) + 1);
      }
    }
    const root = [...(roots.length ? roots : rows)].sort(compareRows)[0]!;
    const latest = [...rows].sort(compareRows).at(-1)!;
    const plan = root.page_plan;
    summaries.push({
      session_id: sessionId,
      root_node_id: root.id,
      latest_node_id: latest.id,
      title: plan?.title || root.page_title || root.query || "Untitled session",
      node_count: rows.length,
      branch_count: [...children.values()].reduce(
        (count, childCount) => count + Math.max(0, childCount - 1),
        0,
      ),
      updated_at: latest.created_at,
      thumbnail_key: root.image_key,
      has_sources: rows.some(
        (row) => Boolean(row.page_plan?.sources?.length || row.sources.length),
      ),
      has_image_seed: rows.some((row) => row.seed_type === "image"),
    });
  }
  return summaries
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id))
    .slice(0, cap);
}

export interface DeletedSessionRecords {
  deleted_nodes: number;
  deleted_world_state: number;
  deleted_world_map: number;
  deleted_presence: number;
  deleted_owner: number;
}

/** Delete only records keyed to one session, keeping global errors untouched. */
export async function deleteSessionRecords(sessionId: string): Promise<DeletedSessionRecords> {
  const db = await getDb();
  const client = await getMongoClient();
  const mongoSession = client.startSession();
  let result: DeletedSessionRecords = {
    deleted_nodes: 0,
    deleted_world_state: 0,
    deleted_world_map: 0,
    deleted_presence: 0,
    deleted_owner: 0,
  };
  try {
    await mongoSession.withTransaction(async () => {
      const nodesResult = await db.collection<NodeDoc>("nodes").deleteMany(
        { session_id: sessionId },
        { session: mongoSession },
      );
      const worldResult = await db.collection<{ _id: string }>("world_state").deleteOne(
        { _id: sessionId },
        { session: mongoSession },
      );
      const worldMapResult = await db.collection<{ _id: string }>("world_map").deleteOne(
        { _id: sessionId },
        { session: mongoSession },
      );
      const presenceResult = await db.collection("session_presence").deleteMany(
        { session_id: sessionId },
        { session: mongoSession },
      );
      const ownerResult = await db.collection<{ _id: string }>("session_owners").deleteOne(
        { _id: sessionId },
        { session: mongoSession },
      );
      result = {
        deleted_nodes: nodesResult.deletedCount,
        deleted_world_state: worldResult.deletedCount,
        deleted_world_map: worldMapResult.deletedCount,
        deleted_presence: presenceResult.deletedCount,
        deleted_owner: ownerResult.deletedCount,
      };
    });
  } finally {
    await mongoSession.endSession();
  }
  return result;
}

function compareRows(a: NodeRow, b: NodeRow): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export interface ErrorDoc extends Document {
  _id?: string;
  trace_id: string | null;
  ts: Date;
  kind: string;
  message: string;
  stack?: string | null;
  body_excerpt?: string | null;
  source: "client" | "backend";
}

export interface ErrorRow {
  trace_id: string | null;
  ts: string;
  kind: string;
  message: string;
  stack: string | null;
  body_excerpt: string | null;
  source: "client" | "backend";
}

export async function recordError(input: Omit<ErrorRow, "ts">): Promise<void> {
  const db = await getDb();
  const collection = db.collection<ErrorDoc>("errors");
  await collection.insertOne({
    _id: crypto.randomUUID(),
    trace_id: input.trace_id,
    ts: new Date(),
    kind: input.kind,
    message: input.message,
    stack: input.stack ?? null,
    body_excerpt: input.body_excerpt ?? null,
    source: input.source,
  });
}

export async function listRecentErrors(limit = 50): Promise<ErrorRow[]> {
  const db = await getDb();
  const collection = db.collection<ErrorDoc>("errors");
  const docs = await collection
    .find({})
    .sort({ ts: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
  return docs.map((doc) => ({
    trace_id: doc.trace_id ?? null,
    ts: doc.ts.toISOString(),
    kind: doc.kind,
    message: doc.message,
    stack: doc.stack ?? null,
    body_excerpt: doc.body_excerpt ?? null,
    source: doc.source,
  }));
}

/** C12 — record the view ESTIMATOR's read as the node's camera truth. A narrow
 *  `$set` on `scene_view.view` only, guarded so it (a) requires an existing
 *  scene_view (no fabricated views on legacy nodes) and (b) NEVER overwrites a
 *  user-pinned camera (`source: "user"` is sacred; policy/estimated stamps are
 *  fair game — the node's view must describe the image as it actually is, so
 *  later zooms/ascends inherit the real projection). Returns whether it wrote. */
export async function updateNodeEstimatedView(
  id: string,
  view: ViewSpec,
): Promise<boolean> {
  const collection = await nodes();
  const res = await collection.updateOne(
    {
      _id: id,
      scene_view: { $ne: null },
      $or: [
        { "scene_view.view": null },
        { "scene_view.view": { $exists: false } },
        { "scene_view.view.source": { $ne: "user" } },
      ],
    },
    { $set: { "scene_view.view": view } },
  );
  return res.matchedCount === 1;
}

/** Stamp a node as having had entity extraction run (set even when it found
 *  zero entities). The durable counterpart to the client's in-memory
 *  "already attempted" guard — read back via `NodeRow.geo_extracted` so a
 *  revisit / reload never silently re-runs the non-deterministic VLM pass.
 *  Best-effort + idempotent; the caller never blocks on it. */
export async function markNodeGeoExtracted(id: string): Promise<void> {
  const collection = await nodes();
  await collection.updateOne(
    { _id: id },
    { $set: { geo_extracted_at: new Date() } },
  );
}

/** The root→node path: walk parent_id up from `nodeId` (cycle-guarded,
 * capped) and return it ROOT-FIRST — the page order a flipbook export
 * reads in. Missing intermediate nodes truncate the walk (best-effort). */
export async function getNodeChain(
  nodeId: string,
  cap = 40
): Promise<NodeRow[]> {
  const collection = await nodes();
  const chain: NodeRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = nodeId;
  while (cursor && !seen.has(cursor) && chain.length < cap) {
    seen.add(cursor);
    const doc = await collection.findOne({ _id: cursor });
    if (!doc) break;
    const row = toRow(doc);
    chain.push(row);
    cursor = row.parent_id;
  }
  return chain.reverse();
}

// ── Public gallery (Wave 7) ──────────────────────────────────────────────────

export interface PublishedSessionDoc extends Document {
  _id: string; // session id
  node_id: string; // the page that fronts the gallery card
  title: string;
  query: string;
  poster_key: string; // store key of the poster image
  published_at: Date;
}

export interface PublishedSessionRow {
  session_id: string;
  node_id: string;
  title: string;
  query: string;
  poster_key: string;
  published_at: string;
}

async function publishedSessions(): Promise<Collection<PublishedSessionDoc>> {
  return (await getDb()).collection<PublishedSessionDoc>("published_sessions");
}

/** Idempotent publish: a session appears in the gallery at most once; a
 * re-publish just refreshes its poster/title/timestamp. */
export async function publishSession(entry: {
  session_id: string;
  node_id: string;
  title: string;
  query: string;
  poster_key: string;
}): Promise<void> {
  const col = await publishedSessions();
  await col.updateOne(
    { _id: entry.session_id },
    {
      $set: {
        node_id: entry.node_id,
        title: entry.title,
        query: entry.query,
        poster_key: entry.poster_key,
        published_at: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function unpublishSession(sessionId: string): Promise<boolean> {
  const col = await publishedSessions();
  const res = await col.deleteOne({ _id: sessionId });
  return res.deletedCount > 0;
}

export async function listPublishedSessions(
  limit = 60
): Promise<PublishedSessionRow[]> {
  const col = await publishedSessions();
  const docs = await col
    .find({})
    .sort({ published_at: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .toArray();
  return docs.map((d) => ({
    session_id: d._id,
    node_id: d.node_id,
    title: d.title,
    query: d.query,
    poster_key: d.poster_key,
    published_at: d.published_at.toISOString(),
  }));
}

// ── Shared sessions (Wave 8): presence + change-stream watch ────────────────

export interface PresenceDoc extends Document {
  _id: string; // `${session_id}:${viewer_id}`
  session_id: string;
  last_seen: Date;
}

async function presence(): Promise<Collection<PresenceDoc>> {
  return (await getDb()).collection<PresenceDoc>("session_presence");
}

const PRESENCE_WINDOW_MS = 45_000;

/** Heartbeat: upsert this viewer's last_seen and return the live count.
 * Docs expire via the TTL index; the count uses a tighter live window. */
export async function touchPresence(
  sessionId: string,
  viewerId: string
): Promise<number> {
  const col = await presence();
  await col.updateOne(
    { _id: `${sessionId}:${viewerId}` },
    { $set: { session_id: sessionId, last_seen: new Date() } },
    { upsert: true }
  );
  return countPresence(sessionId);
}

export async function countPresence(sessionId: string): Promise<number> {
  const col = await presence();
  return col.countDocuments({
    session_id: sessionId,
    last_seen: { $gt: new Date(Date.now() - PRESENCE_WINDOW_MS) },
  });
}

/** A change-stream over this session's node inserts — the read-along feed.
 * Requires a replica set (the compose stack runs single-node rs0); callers
 * catch the unsupported error and degrade. */
export async function watchSessionNodes(sessionId: string) {
  const db = await getDb();
  return db.collection<NodeDoc>("nodes").watch(
    [
      {
        $match: {
          operationType: "insert",
          "fullDocument.session_id": sessionId,
        },
      },
    ],
    { fullDocument: "updateLookup" }
  );
}
