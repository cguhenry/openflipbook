import { NextResponse } from "next/server";

import {
  BackupArchiveError,
  executeOwnerRestore,
  parseOwnerBackupArchive,
  planOwnerRestore,
} from "@/lib/owner-backup";
import { commitOwnerRestore, existingBackupIds } from "@/lib/owner-backup-store";
import {
  deleteStoredObject,
  putStoredBytesCreateOnly,
} from "@/lib/r2";
import { currentOwnerToken } from "@/lib/session-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const CONFIRM_HEADER = "RESTORE_OWNER_BACKUP";

function summary(plan: ReturnType<typeof planOwnerRestore>, dryRun: boolean) {
  return {
    ok: true,
    dry_run: dryRun,
    schema: "openflipbook.backup.v1",
    sessions: plan.sessions.length,
    nodes: plan.nodes.length,
    images: plan.images.length,
    remapped_sessions: Object.entries(plan.session_id_map).filter(
      ([before, after]) => before !== after,
    ).length,
    remapped_nodes: Object.entries(plan.node_id_map).filter(
      ([before, after]) => before !== after,
    ).length,
    provider_calls: 0,
  };
}

export async function POST(req: Request) {
  const declaredSize = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
    return NextResponse.json({ error: "backup archive too large" }, { status: 413 });
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: bytes.byteLength === 0 ? "backup archive is empty" : "backup archive too large" },
      { status: bytes.byteLength === 0 ? 400 : 413 },
    );
  }

  try {
    const parsed = await parseOwnerBackupArchive(bytes);
    const existing = await existingBackupIds();
    const plan = planOwnerRestore(parsed, {
      existingSessionIds: existing.sessionIds,
      existingNodeIds: existing.nodeIds,
    });
    const url = new URL(req.url);
    const confirm = url.searchParams.get("confirm") === "true";
    if (!confirm) return NextResponse.json(summary(plan, true));
    if (req.headers.get("x-openflipbook-restore-confirm") !== CONFIRM_HEADER) {
      return NextResponse.json(
        { error: "explicit restore confirmation header required" },
        { status: 400 },
      );
    }
    const ownerToken = await currentOwnerToken({ mint: true });
    if (!ownerToken) {
      return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
    }
    await executeOwnerRestore(plan, {
      putImage: async (image) => {
        await putStoredBytesCreateOnly(image.key, image.bytes, image.contentType);
      },
      deleteImage: deleteStoredObject,
      commit: async (restorePlan) => {
        await commitOwnerRestore(restorePlan, ownerToken);
      },
    });
    return NextResponse.json(summary(plan, false));
  } catch (error) {
    if (error instanceof BackupArchiveError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "owner restore failed" }, { status: 500 });
  }
}
