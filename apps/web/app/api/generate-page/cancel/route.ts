import { NextResponse } from "next/server";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { error: "MODAL_API_URL is not set", cancelled: false },
      { status: 503 },
    );
  }

  let body: { generation_id?: string };
  try {
    body = (await req.json()) as { generation_id?: string };
  } catch {
    return NextResponse.json(
      { error: "invalid JSON", cancelled: false },
      { status: 400 },
    );
  }
  const generationId = body.generation_id?.trim();
  if (!generationId) {
    return NextResponse.json(
      { error: "generation_id is required", cancelled: false },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(joinModalUrl(modalUrl, "/sse/cancel"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...modalAuthHeaders(),
      },
      body: JSON.stringify({ generation_id: generationId }),
    });
    const payload = await upstream.json().catch(() => ({}));
    return NextResponse.json(payload, { status: upstream.ok ? 200 : 502 });
  } catch {
    // The browser still aborts its local stream when the backend is already
    // unreachable; cancellation is intentionally best-effort at this hop.
    return NextResponse.json(
      { generation_id: generationId, cancelled: false },
      { status: 200 },
    );
  }
}
