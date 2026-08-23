import { NextResponse } from "next/server";

import { listNodesBySession, type NodeRow } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import {
  buildOwnerBackupArchive,
  type BackupSourceNode,
} from "@/lib/owner-backup";
import { getStoredBytes } from "@/lib/r2";
import { listCurrentOwnerSessionIds } from "@/lib/session-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function listAllSessionNodes(sessionId: string): Promise<NodeRow[]> {
  const rows: NodeRow[] = [];
  let cursor: string | null = null;
  do {
    const page = await listNodesBySession(sessionId, { cursor, limit: 200 });
    rows.push(...page.rows);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
}

export async function GET() {
  const env = readServerEnv();
  if (
    !env.MONGODB_URI ||
    !env.MONGODB_DB ||
    !env.R2_BUCKET ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID)
  ) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  try {
    const ownedSessionIds = await listCurrentOwnerSessionIds();
    const sessions: string[] = [];
    const nodes: BackupSourceNode[] = [];
    const images = new Map<string, { bytes: Uint8Array; contentType: string }>();
    for (const sessionId of ownedSessionIds) {
      const rows = await listAllSessionNodes(sessionId);
      if (rows.length === 0) continue;
      sessions.push(sessionId);
      for (const row of rows) {
        const stored = await getStoredBytes(row.image_key);
        if (!stored) {
          return NextResponse.json(
            { error: "owner backup image is unavailable", node_id: row.id },
            { status: 409 },
          );
        }
        images.set(row.image_key, stored);
        nodes.push(row);
      }
    }
    if (sessions.length === 0) {
      return NextResponse.json({ error: "no sessions owned by this browser" }, { status: 404 });
    }

    const backup = await buildOwnerBackupArchive({ sessions, nodes, images });
    const stamp = new Date().toISOString().slice(0, 10);
    const body = backup.bytes.buffer.slice(
      backup.bytes.byteOffset,
      backup.bytes.byteOffset + backup.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="openflipbook-owner-backup-${stamp}.zip"`,
        "Cache-Control": "no-store",
        "Content-Length": String(backup.bytes.byteLength),
        "X-OpenFlipbook-Backup-Sessions": String(backup.manifest.sessions),
        "X-OpenFlipbook-Backup-Nodes": String(backup.manifest.nodes),
      },
    });
  } catch {
    return NextResponse.json({ error: "owner backup failed" }, { status: 500 });
  }
}
