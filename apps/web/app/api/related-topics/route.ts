import { NextResponse } from "next/server";

import { readServerEnv } from "@/lib/env";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";
import { verifyOwnerReadonly } from "@/lib/session-owner";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RelatedTopicsBody {
  session_id?: string;
  page_title?: string;
  query?: string;
  output_locale?: string;
}
/** Text-only proxy for NAS's explicit related-topic chooser. */
export async function POST(req: Request) {
  const env = readServerEnv();
  if (!env.MODAL_API_URL) {
    return NextResponse.json({ error: "MODAL_API_URL is not set" }, { status: 503 });
  }
  let body: RelatedTopicsBody;
  try {
    body = (await req.json()) as RelatedTopicsBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const sessionId = body.session_id?.trim();
  const pageTitle = body.page_title?.trim();
  const query = body.query?.trim();
  if (!sessionId || !pageTitle || !query) {
    return NextResponse.json(
      { error: "missing required fields: session_id, page_title, query" },
      { status: 400 },
    );
  }
  const owner = await verifyOwnerReadonly(sessionId);
  if (!owner.ok) return owner.res;
  const traceId = req.headers.get(TRACE_HEADER) || newTraceId();
  try {
    const upstream = await fetch(joinModalUrl(env.MODAL_API_URL, "/related-topics"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TRACE_HEADER]: traceId,
        ...modalAuthHeaders(),
      },
      body: JSON.stringify({
        session_id: sessionId,
        page_title: pageTitle,
        query,
        output_locale: body.output_locale ?? "auto",
        trace_id: traceId,
      }),
      signal: req.signal,
    });
    const payload = (await upstream.json().catch(() => ({}))) as {
      topics?: unknown;
      error?: string;
    };
    const topics = Array.isArray(payload.topics)
      ? payload.topics
          .filter((topic): topic is string => typeof topic === "string")
          .map((topic) => topic.trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];
    return NextResponse.json(
      { topics, ...(payload.error ? { error: payload.error } : {}) },
      { status: upstream.ok ? 200 : upstream.status, headers: { [TRACE_HEADER]: traceId } },
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return NextResponse.json(
      { error: `related-topics upstream failed: ${(err as Error).message}` },
      { status: 502, headers: { [TRACE_HEADER]: traceId } },
    );
  }
}
