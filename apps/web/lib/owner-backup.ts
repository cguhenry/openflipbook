import type {
  AlignedHotspotV1,
  PagePlanV1,
  ScaleTier,
  SceneView,
} from "@openflipbook/config";
import JSZip from "jszip";

import { isSafeId } from "./ids";
import type { NodeSource } from "./db";

const SCHEMA = "openflipbook.backup.v1";
const DATA_SCHEMA = "openflipbook.backup.data.v1";
const MAX_ENTRIES = 20_000;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const FORBIDDEN_NAME = /(^|\/)(?:\.env(?:\.|$)|pw\.txt$|.*(?:secret|credential|bearer|cookie|token).*)/i;
const SECRET_SIGNAL = /(?:["']?(?:authorization|cookie|password|token|secret|credential|api[_-]?key)["']?\s*:|bearer\s+|pw\.txt|openclaw_gateway_secret)/i;
const HEX64 = /^[0-9a-f]{64}$/;
const BACKUP_NODE_KEYS = new Set([
  "id",
  "parent_id",
  "source_hotspot_id",
  "session_id",
  "query",
  "page_title",
  "image_model",
  "prompt_author_model",
  "aspect_ratio",
  "click_in_parent",
  "sources",
  "relation",
  "scale",
  "scale_tier",
  "scene_view",
  "page_plan",
  "aligned_hotspots",
  "seed_type",
  "created_at",
  "image_path",
  "image_content_type",
]);

export class BackupArchiveError extends Error {
  constructor(code: string, options?: ErrorOptions) {
    super(`OWNER_BACKUP_${code}`, options);
    this.name = "BackupArchiveError";
  }
}

export interface BackupSourceNode {
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
  click_in_parent: { x_pct: number; y_pct: number } | null;
  sources: NodeSource[];
  relation: "descend" | "expand" | "ascend" | "edit";
  scale: "component" | "peer" | "container";
  scale_tier: ScaleTier | null;
  scene_view: SceneView | null;
  page_plan: PagePlanV1 | null;
  aligned_hotspots: AlignedHotspotV1[] | null;
  seed_type: "image" | null;
  created_at: string;
}

export interface BackupNode extends Omit<BackupSourceNode, "image_key"> {
  image_path: string;
  image_content_type: string;
}

export interface BackupFileEntry {
  path: string;
  size_bytes: number;
  sha256: string;
}

export interface BackupManifest {
  schema: typeof SCHEMA;
  created_at: string;
  sessions: number;
  nodes: number;
  files: BackupFileEntry[];
}

export interface ParsedOwnerBackup {
  manifest: BackupManifest;
  sessions: string[];
  nodes: BackupNode[];
  images: Map<string, Uint8Array>;
}

export interface RestoreNode extends Omit<BackupNode, "image_path" | "image_content_type"> {
  image_key: string;
}

export interface RestoreImage {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface OwnerRestorePlan {
  restore_id: string;
  sessions: string[];
  nodes: RestoreNode[];
  images: RestoreImage[];
  session_id_map: Record<string, string>;
  node_id_map: Record<string, string>;
}

function fail(code: string, cause?: unknown): never {
  throw new BackupArchiveError(code, cause instanceof Error ? { cause } : undefined);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", stable.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function jsonBytes(value: unknown): Uint8Array {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (SECRET_SIGNAL.test(text)) fail("secret_signal");
  return Buffer.from(text, "utf8");
}

function safeMemberPath(name: string): void {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/")) {
    fail(`unsafe_path:${name}`);
  }
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  const parts = path.split("/");
  if (!path || parts.some((part) => !part || part === "." || part === "..")) {
    fail(`unsafe_path:${name}`);
  }
  if (FORBIDDEN_NAME.test(name)) fail(`forbidden_member_name:${name}`);
}

function imageExtension(contentType: string, key: string): string {
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  if (known[contentType.toLowerCase()]) return known[contentType.toLowerCase()]!;
  const suffix = key.split(".").pop()?.toLowerCase();
  return suffix && /^[a-z0-9]{1,5}$/.test(suffix) ? suffix : "bin";
}

function validateGraph(sessions: readonly string[], nodes: readonly BackupNode[]): void {
  const sessionSet = new Set<string>();
  for (const sessionId of sessions) {
    if (!isSafeId(sessionId) || sessionSet.has(sessionId)) fail("session_id");
    sessionSet.add(sessionId);
  }
  const byId = new Map<string, BackupNode>();
  for (const node of nodes) {
    if (!isSafeId(node.id) || byId.has(node.id)) fail("node_id");
    if (!sessionSet.has(node.session_id)) fail("node_session");
    if (!node.image_path.startsWith("images/") || !node.image_content_type.startsWith("image/")) {
      fail("node_image");
    }
    safeMemberPath(node.image_path);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    if (node.parent_id !== null) {
      const parent = byId.get(node.parent_id);
      if (!parent || parent.session_id !== node.session_id) fail("parent_lineage");
      if (node.source_hotspot_id) {
        const ids = new Set(parent.page_plan?.hotspots.map((hotspot) => hotspot.id) ?? []);
        if (!ids.has(node.source_hotspot_id)) fail("source_hotspot_lineage");
      }
    } else if (node.source_hotspot_id !== null) {
      fail("root_source_hotspot");
    }
    if (node.scene_view && node.scene_view.node_id !== node.id) {
      fail("scene_view_lineage");
    }
    if (!Number.isFinite(Date.parse(node.created_at))) fail("created_at");
  }
  for (const node of nodes) {
    const visited = new Set<string>();
    let cursor: BackupNode | undefined = node;
    while (cursor) {
      if (visited.has(cursor.id)) fail("parent_cycle");
      visited.add(cursor.id);
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    }
  }
}

export async function buildOwnerBackupArchive(input: {
  sessions: readonly string[];
  nodes: readonly BackupSourceNode[];
  images: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>;
  createdAt?: Date;
}): Promise<{ bytes: Uint8Array; manifest: BackupManifest }> {
  const backupNodes: BackupNode[] = input.nodes.map((node, index) => {
    const stored = input.images.get(node.image_key);
    if (!stored || stored.bytes.byteLength === 0 || !stored.contentType.startsWith("image/")) {
      fail(`missing_image:${node.id}`);
    }
    const safeId = node.id.replace(/[^A-Za-z0-9_-]/g, "_") || "node";
    return {
      id: node.id,
      parent_id: node.parent_id,
      source_hotspot_id: node.source_hotspot_id,
      session_id: node.session_id,
      query: node.query,
      page_title: node.page_title,
      image_model: node.image_model,
      prompt_author_model: node.prompt_author_model,
      aspect_ratio: node.aspect_ratio,
      click_in_parent: node.click_in_parent,
      sources: node.sources,
      relation: node.relation,
      scale: node.scale,
      scale_tier: node.scale_tier,
      scene_view: node.scene_view,
      page_plan: node.page_plan,
      aligned_hotspots: node.aligned_hotspots,
      seed_type: node.seed_type,
      created_at: node.created_at,
      image_path: `images/${String(index + 1).padStart(4, "0")}-${safeId}.${imageExtension(stored.contentType, node.image_key)}`,
      image_content_type: stored.contentType,
    };
  });
  validateGraph(input.sessions, backupNodes);

  const payloads = new Map<string, Uint8Array>();
  payloads.set(
    "data/sessions.json",
    jsonBytes({ schema: DATA_SCHEMA, sessions: input.sessions.map((id) => ({ id })) }),
  );
  payloads.set(
    "data/nodes.json",
    jsonBytes({ schema: DATA_SCHEMA, nodes: backupNodes }),
  );
  backupNodes.forEach((node, index) => {
    const source = input.nodes[index]!;
    payloads.set(node.image_path, input.images.get(source.image_key)!.bytes);
  });

  const files: BackupFileEntry[] = [];
  for (const [path, bytes] of payloads) {
    files.push({
      path,
      size_bytes: bytes.byteLength,
      sha256: await sha256(bytes),
    });
  }
  const manifest: BackupManifest = {
    schema: SCHEMA,
    created_at: (input.createdAt ?? new Date()).toISOString(),
    sessions: input.sessions.length,
    nodes: backupNodes.length,
    files,
  };
  const zip = new JSZip();
  for (const [path, bytes] of payloads) {
    safeMemberPath(path);
    zip.file(path, bytes, { createFolders: false });
  }
  zip.file("manifest.json", jsonBytes(manifest), { createFolders: false });
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { bytes, manifest };
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  fail("zip_eocd");
}

function validatedMemberNames(bytes: Uint8Array): string[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(bytes, view);
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      fail("zip64_unsupported");
    }
    if (entries > MAX_ENTRIES || centralOffset + centralSize > bytes.byteLength) {
      fail("zip_bounds");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const names: string[] = [];
    const seen = new Set<string>();
    let totalUncompressed = 0;
    let offset = centralOffset;
    for (let index = 0; index < entries; index++) {
      if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
        fail("central_directory");
      }
      const flags = view.getUint16(offset + 8, true);
      if (flags & 0x1) fail("encrypted_archive");
      const uncompressed = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > bytes.byteLength) fail("central_directory");
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      safeMemberPath(name);
      if (seen.has(name)) fail(`duplicate_member:${name}`);
      seen.add(name);
      names.push(name);
      totalUncompressed += uncompressed;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) fail("archive_too_large");

      if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
        fail("local_header");
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localEnd = localOffset + 30 + localNameLength + localExtraLength;
      if (localEnd > bytes.byteLength) fail("local_header");
      const localName = decoder.decode(
        bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      );
      if (localName !== name) fail("header_name_mismatch");
      offset = end;
    }
    if (offset !== centralOffset + centralSize) fail("central_size");
    return names;
  } catch (error) {
    if (error instanceof BackupArchiveError) throw error;
    fail("zip_structure", error);
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function parseManifest(value: unknown): BackupManifest {
  const raw = object(value, "manifest_object");
  exactKeys(raw, new Set(["schema", "created_at", "sessions", "nodes", "files"]), "manifest_fields");
  if (raw.schema !== SCHEMA || typeof raw.created_at !== "string") fail("manifest_schema");
  if (!Number.isInteger(raw.sessions) || !Number.isInteger(raw.nodes)) fail("manifest_counts");
  if (!Array.isArray(raw.files)) fail("manifest_files");
  const files = raw.files.map((value) => {
    const row = object(value, "manifest_file");
    exactKeys(row, new Set(["path", "size_bytes", "sha256"]), "manifest_file_fields");
    if (
      typeof row.path !== "string" ||
      !Number.isInteger(row.size_bytes) ||
      Number(row.size_bytes) < 0 ||
      typeof row.sha256 !== "string" ||
      !HEX64.test(row.sha256)
    ) {
      fail("manifest_file");
    }
    safeMemberPath(row.path);
    return {
      path: row.path,
      size_bytes: Number(row.size_bytes),
      sha256: row.sha256,
    };
  });
  return {
    schema: SCHEMA,
    created_at: raw.created_at,
    sessions: Number(raw.sessions),
    nodes: Number(raw.nodes),
    files,
  };
}

function parseBackupNode(value: unknown): BackupNode {
  const raw = object(value, "node_row");
  exactKeys(raw, BACKUP_NODE_KEYS, "node_fields");
  const stringFields = [
    "id",
    "session_id",
    "query",
    "page_title",
    "image_model",
    "prompt_author_model",
    "aspect_ratio",
    "created_at",
    "image_path",
    "image_content_type",
  ];
  if (stringFields.some((key) => typeof raw[key] !== "string")) fail("node_shape");
  if (raw.parent_id !== null && typeof raw.parent_id !== "string") fail("node_shape");
  if (raw.source_hotspot_id !== null && typeof raw.source_hotspot_id !== "string") {
    fail("node_shape");
  }
  if (!["descend", "expand", "ascend", "edit"].includes(String(raw.relation))) {
    fail("node_relation");
  }
  if (!["component", "peer", "container"].includes(String(raw.scale))) fail("node_scale");
  if (raw.scale_tier !== null && typeof raw.scale_tier !== "string") fail("node_scale_tier");
  if (raw.seed_type !== null && raw.seed_type !== "image") fail("node_seed_type");
  if (!Array.isArray(raw.sources)) fail("node_sources");
  for (const value of raw.sources) {
    const source = object(value, "node_source");
    exactKeys(
      source,
      new Set(["id", "url", "title", "snippet", "engine"]),
      "node_source_fields",
    );
    if (
      typeof source.url !== "string" ||
      (source.title !== null && typeof source.title !== "string") ||
      (source.id !== undefined && typeof source.id !== "string") ||
      (source.snippet !== undefined && typeof source.snippet !== "string") ||
      (source.engine !== undefined && source.engine !== null && typeof source.engine !== "string")
    ) {
      fail("node_source");
    }
  }
  if (raw.click_in_parent !== null) {
    const click = object(raw.click_in_parent, "node_click");
    exactKeys(click, new Set(["x_pct", "y_pct"]), "node_click_fields");
    if (!Number.isFinite(click.x_pct) || !Number.isFinite(click.y_pct)) fail("node_click");
  }
  if (raw.page_plan !== null) {
    const plan = object(raw.page_plan, "node_page_plan");
    if (!Array.isArray(plan.hotspots)) fail("node_page_plan");
    for (const hotspot of plan.hotspots) {
      if (typeof object(hotspot, "node_hotspot").id !== "string") fail("node_hotspot");
    }
  }
  if (raw.aligned_hotspots !== null && !Array.isArray(raw.aligned_hotspots)) {
    fail("node_aligned_hotspots");
  }
  if (raw.scene_view !== null && typeof object(raw.scene_view, "node_scene_view").node_id !== "string") {
    fail("node_scene_view");
  }
  return raw as unknown as BackupNode;
}

export async function parseOwnerBackupArchive(
  input: Uint8Array,
): Promise<ParsedOwnerBackup> {
  const bytes = new Uint8Array(input);
  const centralNames = validatedMemberNames(bytes);
  const fileNames = centralNames.filter((name) => !name.endsWith("/"));
  if (!fileNames.includes("manifest.json")) fail("manifest_missing");

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch (error) {
    fail("zip_crc", error);
  }
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) fail("manifest_missing");
  let manifest: BackupManifest;
  try {
    const manifestText = await manifestFile.async("string");
    if (SECRET_SIGNAL.test(manifestText)) fail("secret_signal");
    manifest = parseManifest(JSON.parse(manifestText));
  } catch (error) {
    if (error instanceof BackupArchiveError) throw error;
    fail("manifest_json", error);
  }
  const declared = new Map<string, BackupFileEntry>();
  for (const row of manifest.files) {
    if (row.path === "manifest.json" || declared.has(row.path)) {
      fail(`declared_duplicate:${row.path}`);
    }
    declared.set(row.path, row);
  }
  const actual = fileNames.filter((name) => name !== "manifest.json");
  if (
    actual.length !== declared.size ||
    actual.some((name) => !declared.has(name)) ||
    [...declared].some(([name]) => !actual.includes(name))
  ) {
    fail("manifest_coverage");
  }

  const payloads = new Map<string, Uint8Array>();
  for (const [path, row] of declared) {
    const file = zip.file(path);
    if (!file) fail(`payload_missing:${path}`);
    const payload = await file.async("uint8array");
    if (payload.byteLength !== row.size_bytes || await sha256(payload) !== row.sha256) {
      fail(`hash_or_size:${path}`);
    }
    payloads.set(path, payload);
  }
  const sessionsBytes = payloads.get("data/sessions.json");
  const nodesBytes = payloads.get("data/nodes.json");
  if (!sessionsBytes || !nodesBytes) fail("data_payloads");
  const sessionsText = Buffer.from(sessionsBytes).toString("utf8");
  const nodesText = Buffer.from(nodesBytes).toString("utf8");
  if (SECRET_SIGNAL.test(sessionsText) || SECRET_SIGNAL.test(nodesText)) fail("secret_signal");

  let sessionsRaw: Record<string, unknown>;
  let nodesRaw: Record<string, unknown>;
  try {
    sessionsRaw = object(JSON.parse(sessionsText), "sessions_json");
    nodesRaw = object(JSON.parse(nodesText), "nodes_json");
  } catch (error) {
    if (error instanceof BackupArchiveError) throw error;
    fail("data_json", error);
  }
  if (sessionsRaw.schema !== DATA_SCHEMA || nodesRaw.schema !== DATA_SCHEMA) {
    fail("data_schema");
  }
  if (!Array.isArray(sessionsRaw.sessions) || !Array.isArray(nodesRaw.nodes)) {
    fail("data_shape");
  }
  const sessions = sessionsRaw.sessions.map((value) => {
    const row = object(value, "session_row");
    exactKeys(row, new Set(["id"]), "session_fields");
    if (!isSafeId(row.id)) fail("session_id");
    return row.id;
  });
  const nodes = nodesRaw.nodes.map(parseBackupNode);
  if (manifest.sessions !== sessions.length || manifest.nodes !== nodes.length) {
    fail("manifest_counts");
  }
  validateGraph(sessions, nodes);
  const images = new Map<string, Uint8Array>();
  for (const node of nodes) {
    const image = payloads.get(node.image_path);
    if (!image) fail(`missing_image:${node.id}`);
    images.set(node.image_path, image);
  }
  return { manifest, sessions, nodes, images };
}

function uniqueId(existing: Set<string>, makeId: () => string): string {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const candidate = makeId();
    if (!isSafeId(candidate)) fail("generated_id");
    if (!existing.has(candidate)) {
      existing.add(candidate);
      return candidate;
    }
  }
  fail("id_exhausted");
}

export function planOwnerRestore(
  backup: ParsedOwnerBackup,
  options: {
    existingSessionIds: ReadonlySet<string>;
    existingNodeIds: ReadonlySet<string>;
    makeId?: () => string;
  },
): OwnerRestorePlan {
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  const reservedSessions = new Set(options.existingSessionIds);
  const reservedNodes = new Set(options.existingNodeIds);
  const restoreId = uniqueId(new Set<string>(), makeId);
  const sessionIdMap: Record<string, string> = {};
  for (const sessionId of backup.sessions) {
    if (reservedSessions.has(sessionId)) {
      sessionIdMap[sessionId] = uniqueId(reservedSessions, makeId);
    } else {
      reservedSessions.add(sessionId);
      sessionIdMap[sessionId] = sessionId;
    }
  }
  const nodeIdMap: Record<string, string> = {};
  for (const node of backup.nodes) {
    if (reservedNodes.has(node.id)) {
      nodeIdMap[node.id] = uniqueId(reservedNodes, makeId);
    } else {
      reservedNodes.add(node.id);
      nodeIdMap[node.id] = node.id;
    }
  }

  const images: RestoreImage[] = [];
  const nodes: RestoreNode[] = backup.nodes.map((node) => {
    const id = nodeIdMap[node.id]!;
    const suffix = imageExtension(node.image_content_type, node.image_path);
    const imageKey = `owner-restores/${restoreId}/${id}.${suffix}`;
    const image = backup.images.get(node.image_path);
    if (!image) fail(`missing_image:${node.id}`);
    images.push({
      key: imageKey,
      bytes: image,
      contentType: node.image_content_type,
    });
    const sceneView = node.scene_view
      ? { ...node.scene_view, node_id: nodeIdMap[node.scene_view.node_id]! }
      : null;
    const {
      image_path: _imagePath,
      image_content_type: _imageContentType,
      ...nodeData
    } = node;
    return {
      ...nodeData,
      id,
      parent_id: node.parent_id ? nodeIdMap[node.parent_id]! : null,
      session_id: sessionIdMap[node.session_id]!,
      source_hotspot_id: node.source_hotspot_id,
      scene_view: sceneView,
      image_key: imageKey,
    };
  });
  return {
    restore_id: restoreId,
    sessions: backup.sessions.map((id) => sessionIdMap[id]!),
    nodes,
    images,
    session_id_map: sessionIdMap,
    node_id_map: nodeIdMap,
  };
}

export async function executeOwnerRestore(
  plan: OwnerRestorePlan,
  operations: {
    putImage: (image: RestoreImage) => Promise<void>;
    deleteImage: (key: string) => Promise<void>;
    commit: (plan: OwnerRestorePlan) => Promise<void>;
  },
): Promise<void> {
  const created: string[] = [];
  try {
    for (const image of plan.images) {
      await operations.putImage(image);
      created.push(image.key);
    }
    await operations.commit(plan);
  } catch (error) {
    let cleanupError: unknown;
    for (const key of [...created].reverse()) {
      try {
        await operations.deleteImage(key);
      } catch (failure) {
        cleanupError ??= failure;
      }
    }
    if (cleanupError) fail("restore_cleanup_failed", cleanupError);
    throw error;
  }
}
