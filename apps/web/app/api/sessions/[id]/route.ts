import { NextResponse } from "next/server";
import { deleteSessionRecords, listNodesBySession } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { nodeImagePath } from "@/lib/node-image";
import { deleteStoredObjects, uniqueStoredKeys } from "@/lib/r2";
import { isSafeId } from "@/lib/ids";
import { requireOwner } from "@/lib/session-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionDeleteCode =
  | "SESSION_DELETE_OK"
  | "SESSION_DELETE_INVALID"
  | "SESSION_DELETE_UNAVAILABLE"
  | "SESSION_DELETE_FORBIDDEN"
  | "SESSION_DELETE_FAILED"
  | "SESSION_DELETE_IMAGE_CLEANUP_WARNING";

function deleteError(
  code: Exclude<SessionDeleteCode, "SESSION_DELETE_OK" | "SESSION_DELETE_IMAGE_CLEANUP_WARNING">,
  error: string,
  status: number,
) {
  return NextResponse.json({ code, error }, { status });
}

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 200;

  const { rows, next_cursor } = await listNodesBySession(id, {
    cursor,
    limit: Number.isFinite(limit) ? limit : 200,
  });
  const publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");

  return NextResponse.json({
    session_id: id,
    next_cursor,
    nodes: rows.map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      source_hotspot_id: row.source_hotspot_id,
      session_id: row.session_id,
      query: row.query,
      page_title: row.page_title,
      image_url: `${publicBase}/${row.image_key}`,
      browser_image_url: nodeImagePath(row.id),
      image_model: row.image_model,
      prompt_author_model: row.prompt_author_model,
      aspect_ratio: row.aspect_ratio,
      click_in_parent: row.click_in_parent,
      sources: row.sources,
      // How the node hangs off its parent (descend/expand/ascend/edit) — the
      // ?continue= hydration rides it onto the in-session Page so the map
      // views can render breadth vs depth like the atlas. Additive: old
      // clients ignore it, and toRow defaults missing Mongo values "descend".
      relation: row.relation,
      scene_view: row.scene_view,
      geo_extracted: row.geo_extracted,
      page_plan: row.page_plan ?? null,
      aligned_hotspots: row.aligned_hotspots ?? null,
      seed_type: row.seed_type ?? null,
      created_at: row.created_at,
    })),
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!isSafeId(id)) {
    return deleteError("SESSION_DELETE_INVALID", "invalid session id", 400);
  }
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return deleteError(
      "SESSION_DELETE_UNAVAILABLE",
      "persistence not configured",
      503,
    );
  }
  if (!env.FLIPBOOK_NAS_SELF_USE) {
    const owner = await requireOwner(id);
    if (!owner.ok) {
      return deleteError(
        "SESSION_DELETE_FORBIDDEN",
        "this session belongs to another browser",
        403,
      );
    }
  }

  try {
    const rows: Awaited<ReturnType<typeof listNodesBySession>>["rows"] = [];
    let cursor: string | null = null;
    do {
      const page = await listNodesBySession(id, { cursor, limit: 200 });
      rows.push(...page.rows);
      cursor = page.next_cursor;
    } while (cursor);
    const imageKeys = uniqueStoredKeys(rows.map((row) => row.image_key));
    const deleted = await deleteSessionRecords(id);
    let imageCleanupFailed = false;
    try {
      await deleteStoredObjects(imageKeys);
    } catch {
      imageCleanupFailed = true;
    }
    return NextResponse.json({
      code: imageCleanupFailed
        ? "SESSION_DELETE_IMAGE_CLEANUP_WARNING"
        : "SESSION_DELETE_OK",
      deleted_session_id: id,
      deleted_nodes: deleted.deleted_nodes,
      deleted_images: imageKeys.length,
      image_cleanup_failed: imageCleanupFailed,
    });
  } catch {
    return deleteError("SESSION_DELETE_FAILED", "session delete failed", 500);
  }
}
