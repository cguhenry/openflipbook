import { NextResponse } from "next/server";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { ok: false, error: "MODAL_API_URL not set" },
      { status: 503 }
    );
  }
  try {
    const upstream = await fetch(joinModalUrl(modalUrl, "/status"), {
      method: "GET",
      cache: "no-store",
      headers: modalAuthHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    const raw = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    const providers = raw?.providers as Record<string, unknown> | undefined;
    return NextResponse.json(
      {
        ok: raw?.ok === true,
        live_provider: typeof raw?.live_provider === "string" ? raw.live_provider : "unknown",
        provider_mode: typeof raw?.provider_mode === "string" ? raw.provider_mode : "unknown",
        openclaw_connected: raw?.openclaw_connected === true,
        planner_vision_model:
          typeof raw?.planner_vision_model === "string"
            ? raw.planner_vision_model
            : "openai/gpt-5.6-luna",
        image_model:
          typeof raw?.image_model === "string" ? raw.image_model : "openai/gpt-image-2",
        searxng_connected: raw?.searxng_connected === true,
        mongo_connected: raw?.mongo_connected === true ? true : raw?.mongo_connected === false ? false : null,
        minio_connected: raw?.minio_connected === true ? true : raw?.minio_connected === false ? false : null,
        mock_mode: raw?.mock_mode === true,
        providers: {
          fal: providers?.fal === true,
          openrouter: providers?.openrouter === true,
        },
      },
      { status: upstream.status },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "status_unreachable",
      },
      { status: 502 }
    );
  }
}
