import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import QRCode from "qrcode";

import { getNode } from "@/lib/db";
import { readServerEnv } from "@/lib/env";
import { DEFAULT_UI_LOCALE, normalizeUiLocale } from "@/lib/i18n";
import { safeStoredImageMedia } from "@/lib/node-image";
import { postcardLayout, type PostcardNode } from "@/lib/postcard";
import { getStoredBytes } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ nodeId: string }>;
}

export async function GET(req: Request, { params }: Params) {
  const { nodeId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return NextResponse.json({ error: "persistence not configured" }, { status: 503 });
  }

  const row = await getNode(nodeId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const stored = await getStoredBytes(row.image_key);
  if (!stored) return NextResponse.json({ error: "not found" }, { status: 404 });
  const media = safeStoredImageMedia(stored.contentType);
  if (!media) {
    return NextResponse.json(
      { error: "unsupported image content type" },
      { status: 415 },
    );
  }
  const reqUrl = new URL(req.url);
  const uiLocale = normalizeUiLocale(
    reqUrl.searchParams.get("ui_locale") ?? DEFAULT_UI_LOCALE,
    DEFAULT_UI_LOCALE,
  );
  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  const permalink = `${baseUrl}/n/${row.id}`;

  const qrDataUrl = await QRCode.toDataURL(permalink, {
    margin: 1,
    width: 280,
    color: { dark: "#2a1a08", light: "#f4ead800" },
  });

  const node: PostcardNode = {
    nodeId: row.id,
    title: row.page_title || row.query,
    imageUrl: `data:${media.contentType};base64,${stored.bytes.toString("base64")}`,
    citationCount: row.sources.length,
    locale: uiLocale,
  };

  const download = reqUrl.searchParams.get("download") === "1";
  const filename = `openflipbook-${row.id}.png`;

  return new ImageResponse(postcardLayout(node, baseUrl, qrDataUrl), {
    width: 1080,
    height: 1350,
    headers: download
      ? { "Content-Disposition": `attachment; filename="${filename}"` }
      : {},
  });
}
