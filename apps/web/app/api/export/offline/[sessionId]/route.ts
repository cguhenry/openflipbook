import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

import { listNodesBySession } from "@/lib/db";
import {
  buildPortableZip,
  type PortableExportNode,
  type PortableZipAssets,
} from "@/lib/export-build";
import { readServerEnv } from "@/lib/env";
import { isSafeId } from "@/lib/ids";
import { getStoredBytes } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ sessionId: string }>;
}

const OFFLINE_ASSET_DIRS = [
  join(process.cwd(), "public/offline"),
  join(process.cwd(), "apps/web/public/offline"),
];

async function readOfflineAsset(relativePath: string): Promise<string> {
  let lastError: unknown;
  for (const directory of OFFLINE_ASSET_DIRS) {
    try {
      return await readFile(join(directory, relativePath), "utf8");
    } catch (error) {
      lastError = error;
      if (
        typeof error !== "object" ||
        error === null ||
        (error as { code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function readOfflineAssets(): Promise<PortableZipAssets> {
  return {
    indexHtml: await readOfflineAsset("index.html"),
    playerCss: await readOfflineAsset("assets/player.css"),
    playerJs: await readOfflineAsset("assets/player.js"),
  };
}

function imageExtension(contentType: string, key: string): string {
  const type = contentType.toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  const suffix = key.split(".").pop()?.toLowerCase();
  return suffix && /^[a-z0-9]{1,5}$/.test(suffix) ? suffix : "jpg";
}

function imageAsset(
  index: number,
  nodeId: string,
  stored: { contentType: string } | null,
  key: string,
): string {
  if (!stored) return "";
  const safeId = nodeId.replace(/[^A-Za-z0-9_-]/g, "_") || "node";
  return (
    "images/" +
    String(index + 1).padStart(4, "0") +
    "-" +
    safeId +
    "." +
    imageExtension(stored.contentType, key)
  );
}

async function listAllSessionNodes(sessionId: string) {
  const rows: Awaited<ReturnType<typeof listNodesBySession>>["rows"] = [];
  let cursor: string | null = null;
  do {
    const page = await listNodesBySession(sessionId, { cursor, limit: 200 });
    rows.push(...page.rows);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
}

export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  if (!isSafeId(sessionId)) {
    return NextResponse.json({ error: "invalid session id" }, { status: 400 });
  }

  const env = readServerEnv();
  if (
    !env.MONGODB_URI ||
    !env.MONGODB_DB ||
    !env.R2_BUCKET ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_PUBLIC_BASE_URL ||
    (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID)
  ) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  const rows = await listAllSessionNodes(sessionId);
  if (rows.length === 0) {
    return NextResponse.json({ error: "session not found or empty" }, { status: 404 });
  }

  const nodes: PortableExportNode[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const stored = await getStoredBytes(row.image_key);
    nodes.push({
      id: row.id,
      parent_id: row.parent_id,
      session_id: row.session_id,
      query: row.query,
      page_title: row.page_title || row.query,
      image_asset: imageAsset(index, row.id, stored, row.image_key),
      aspect_ratio: row.aspect_ratio,
      click_in_parent: row.click_in_parent,
      page_plan: row.page_plan,
      aligned_hotspots: row.aligned_hotspots,
      created_at: row.created_at,
      bytes: stored?.bytes ?? null,
    });
  }

  const bytes = await buildPortableZip(nodes, await readOfflineAssets());
  const stamp = sessionId.slice(0, 8);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=\"openflipbook-offline-" + stamp + ".zip\"",
    },
  });
}
