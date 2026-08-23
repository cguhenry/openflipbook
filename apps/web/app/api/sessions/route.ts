import { NextResponse } from "next/server";

import { listSessionSummaries } from "@/lib/db";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  const base = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? null;
  const sessions = await listSessionSummaries();
  return NextResponse.json({
    sessions: sessions.map((session) => ({
      session_id: session.session_id,
      root_node_id: session.root_node_id,
      latest_node_id: session.latest_node_id,
      title: session.title,
      node_count: session.node_count,
      branch_count: session.branch_count,
      updated_at: session.updated_at,
      thumbnail_url: base ? `${base}/${session.thumbnail_key}` : null,
      has_sources: session.has_sources,
      has_image_seed: session.has_image_seed,
    })),
  });
}
