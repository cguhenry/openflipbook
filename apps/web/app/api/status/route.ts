import { NextResponse } from "next/server";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { readCoreReadiness } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USAGE_COUNTERS = [
  "generation_requests",
  "generation_success",
  "generation_failed",
  "generation_cancelled",
  "planner_calls",
  "alignment_calls",
  "image_calls",
  "searxng_searches",
] as const;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function safeBreaker(value: unknown) {
  const row = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const state = ["closed", "open", "half_open"].includes(String(row.state))
    ? String(row.state)
    : "closed";
  return {
    state,
    consecutive_failures: count(row.consecutive_failures),
    retry_after_seconds: count(row.retry_after_seconds),
    failure_threshold: count(row.failure_threshold),
    cooldown_seconds: count(row.cooldown_seconds),
  };
}

function safeUsage(value: unknown) {
  const usage = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const rawCounters = usage.counters && typeof usage.counters === "object"
    ? usage.counters as Record<string, unknown>
    : {};
  const rawCaps = usage.caps && typeof usage.caps === "object"
    ? usage.caps as Record<string, unknown>
    : {};
  return {
    scope: "since backend start",
    counters: Object.fromEntries(
      USAGE_COUNTERS.map((key) => [key, count(rawCounters[key])]),
    ),
    caps: {
      runtime_generations: count(rawCaps.runtime_generations),
      session_generations: count(rawCaps.session_generations),
    },
    accepted_generations: count(usage.accepted_generations),
    tracked_sessions: count(usage.tracked_sessions),
  };
}

export async function GET() {
  const modalUrl = process.env.MODAL_API_URL;
  const readinessPromise = readCoreReadiness();
  if (!modalUrl) {
    const readiness = await readinessPromise;
    return NextResponse.json(
      {
        ok: false,
        error: "backend_not_configured",
        mongo_connected: readiness.mongo,
        minio_connected: readiness.minio,
      },
      { status: 503 }
    );
  }
  try {
    const [readiness, upstream] = await Promise.all([
      readinessPromise,
      fetch(joinModalUrl(modalUrl, "/status"), {
        method: "GET",
        cache: "no-store",
        headers: modalAuthHeaders(),
        signal: AbortSignal.timeout(4000),
      }),
    ]);
    const raw = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    const providers = raw?.providers as Record<string, unknown> | undefined;
    const breakers = raw?.breakers as Record<string, unknown> | undefined;
    return NextResponse.json(
      {
        ok: raw?.ok === true && readiness.ok,
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
        mongo_connected: readiness.mongo,
        minio_connected: readiness.minio,
        mock_mode: raw?.mock_mode === true,
        providers: raw?.live_provider === "openclaw"
          ? { openclaw: providers?.openclaw === true }
          : {
              fal: providers?.fal === true,
              openrouter: providers?.openrouter === true,
            },
        provider_control: "read_only",
        model_control: "read_only",
        alternate_provider_fallback: raw?.alternate_provider_fallback === true,
        breakers: {
          responses: safeBreaker(breakers?.responses),
          image: safeBreaker(breakers?.image),
        },
        usage: safeUsage(raw?.usage),
      },
      { status: upstream.ok && readiness.ok ? 200 : 503 },
    );
  } catch {
    const readiness = await readinessPromise;
    return NextResponse.json(
      {
        ok: false,
        error: "status_unreachable",
        mongo_connected: readiness.mongo,
        minio_connected: readiness.minio,
      },
      { status: 502 }
    );
  }
}
