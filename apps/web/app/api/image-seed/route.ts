import { NextResponse } from "next/server";

import { inlineStoredImage } from "@/lib/r2";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { verifyOwnerReadonly } from "@/lib/session-owner";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json({ error: "MODAL_API_URL not set." }, { status: 503 });
  }

  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  const raw = await req.text();
  let body: { session_id?: string; image_data_url?: string; trace_id?: string };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.session_id || !body.image_data_url) {
    return NextResponse.json(
      { error: "missing session_id or image_data_url" },
      { status: 400 },
    );
  }
  const auth = await verifyOwnerReadonly(body.session_id);
  if (!auth.ok) return auth.res;

  let upstreamBody = raw;
  if (!body.image_data_url.startsWith("data:")) {
    const inlined = await inlineStoredImage(body.image_data_url);
    if (inlined) {
      upstreamBody = JSON.stringify({ ...body, image_data_url: inlined });
    }
  }
  try {
    const upstream = await fetch(joinModalUrl(modalUrl, "/image-seed"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TRACE_HEADER]: traceId,
        ...modalAuthHeaders(),
      },
      body: upstreamBody,
      signal: req.signal,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        [TRACE_HEADER]: traceId,
      },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return new Response(null, { status: 499 });
    return NextResponse.json({ error: "image seed upstream unavailable" }, { status: 502 });
  }
}
