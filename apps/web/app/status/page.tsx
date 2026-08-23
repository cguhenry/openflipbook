import { readServerEnv } from "@/lib/env";
import { listRecentErrors } from "@/lib/db";
import { getStrings, type LocaleStrings } from "@/lib/i18n";
import { modalAuthHeaders } from "@/lib/modal";
import { readCoreReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";

interface Row {
  key: string;
  required: boolean;
  ok: boolean;
  hint: string;
}

interface BackendStatus {
  ok?: boolean;
  service?: string;
  version?: string;
  uptime_s?: number;
  in_flight?: number;
  last_error_ts?: number | null;
  providers?: { openclaw?: boolean };
  live_provider?: string;
  provider_mode?: string;
  openclaw_connected?: boolean;
  planner_vision_model?: string;
  image_model?: string;
  searxng_connected?: boolean;
  mongo_connected?: boolean | null;
  minio_connected?: boolean | null;
  mock_mode?: boolean;
  alternate_provider_fallback?: boolean;
  breakers?: Record<string, {
    state?: string;
    consecutive_failures?: number;
    retry_after_seconds?: number;
  }>;
  usage?: {
    scope?: string;
    counters?: Record<string, number>;
    caps?: { runtime_generations?: number; session_generations?: number };
  };
  error?: string;
}

async function fetchBackendStatus(): Promise<BackendStatus | null> {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) return null;
  try {
    const res = await fetch(`${modalUrl.replace(/\/$/, "")}/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: modalAuthHeaders(),
    });
    if (!res.ok) return { error: "unavailable" };
    return (await res.json()) as BackendStatus;
  } catch {
    return { error: "unavailable" };
  }
}

function buildRows(env: ReturnType<typeof readServerEnv>, t: LocaleStrings): Row[] {
  return [
    {
      key: "MODAL_API_URL",
      required: true,
      ok: Boolean(env.MODAL_API_URL),
      hint: t.backendUrlHint,
    },
    {
      key: "MONGODB_URI + MONGODB_DB",
      required: true,
      ok: Boolean(env.MONGODB_URI && env.MONGODB_DB),
      hint: t.mongoConfigHint,
    },
    {
      key: "MinIO / S3 object storage",
      required: true,
      ok: Boolean(
        (env.R2_ENDPOINT || env.R2_ACCOUNT_ID) &&
          env.R2_ACCESS_KEY_ID &&
          env.R2_SECRET_ACCESS_KEY &&
          env.R2_BUCKET &&
          env.R2_PUBLIC_BASE_URL
      ),
      hint: t.objectStorageHint,
    },
  ];
}

function breakerLabel(state: string | undefined, t: LocaleStrings): string {
  if (state === "open") return t.breakerOpen;
  if (state === "closed") return t.breakerClosed;
  if (state === "half_open") return t.breakerHalfOpen;
  return t.unknown;
}

export default async function StatusPage() {
  const t = getStrings("zh-TW");
  const env = readServerEnv();
  const rows = buildRows(env, t);
  const allRequired = rows.filter((r) => r.required).every((r) => r.ok);

  const [backend, recentErrors, readiness] = await Promise.all([
    fetchBackendStatus(),
    env.MONGODB_URI && env.MONGODB_DB
      ? listRecentErrors(20).catch(() => [])
      : Promise.resolve([]),
    readCoreReadiness(),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold">{t.environmentStatus}</h1>
      <p className="mt-2 text-sm opacity-70">
        {t.environmentStatusHelp}
      </p>

      <div
        className={`mt-6 rounded-xl border p-4 text-sm ${
          allRequired
            ? "border-green-600 bg-green-50 text-green-900"
            : "border-amber-600 bg-amber-50 text-amber-900"
        }`}
      >
        {allRequired
          ? t.allServicesConfigured
          : t.missingServiceConfiguration}
      </div>

      <ul className="mt-6 space-y-3">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex items-start justify-between gap-4 rounded-lg border border-[var(--color-ink)]/20 bg-white/70 p-4"
          >
            <div>
              <code className="font-mono text-sm">{r.key}</code>
              <p className="mt-1 text-xs opacity-70">{r.hint}</p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs ${
                r.ok
                  ? "bg-green-600 text-white"
                  : r.required
                    ? "bg-red-600 text-white"
                    : "bg-gray-300 text-black"
              }`}
            >
              {r.ok ? t.set : r.required ? t.missing : t.notSet}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-xl font-semibold">{t.backendHealth}</h2>
      {!backend ? (
        <p className="mt-2 text-sm opacity-70">
          {t.backendNotConfigured}
        </p>
      ) : backend.error ? (
        <p className="mt-2 text-sm text-red-700">
          {t.backendUnreachable}
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <li>
            Backend:{" "}
            <span className={readiness.backend ? "text-green-700" : "text-amber-700"}>
              {readiness.backend ? t.connected : t.unavailable}
            </span>
          </li>
          <li>
            OpenClaw:{" "}
            <span className={backend.openclaw_connected ? "text-green-700" : "text-amber-700"}>
              {backend.openclaw_connected ? t.connected : t.unavailable}
            </span>
          </li>
          <li>
            SearXNG:{" "}
            <span className={backend.searxng_connected ? "text-green-700" : "text-amber-700"}>
              {backend.searxng_connected ? t.connected : t.unavailable}
            </span>
          </li>
          <li>{t.plannerVision}: <code>{backend.planner_vision_model ?? "openai/gpt-5.6-luna"}</code></li>
          <li>{t.imageModel}: <code>{backend.image_model ?? "openai/gpt-image-2"}</code></li>
          <li>{t.provider}: <code>{backend.live_provider ?? t.unknown}</code></li>
          <li>{t.mode}: <code>{backend.provider_mode ?? t.unknown}</code>{backend.mock_mode ? ` (${t.mock})` : ""}</li>
          <li>
            Mongo:{" "}
            <span className={readiness.mongo ? "text-green-700" : "text-amber-700"}>
              {readiness.mongo ? t.connected : t.unavailable}
            </span>
          </li>
          <li>
            MinIO:{" "}
            <span className={readiness.minio ? "text-green-700" : "text-amber-700"}>
              {readiness.minio ? t.connected : t.unavailable}
            </span>
          </li>
          <li>{t.providerControl}: <code>{t.readOnly}</code></li>
          <li>{t.fallback}: <code>{backend.alternate_provider_fallback ? t.unexpectedlyEnabled : t.none}</code></li>
          <li>
            {t.responsesBreaker}: <code>{breakerLabel(backend.breakers?.responses?.state, t)}</code>
            {backend.breakers?.responses?.retry_after_seconds
              ? ` (${backend.breakers.responses.retry_after_seconds}s)`
              : ""}
          </li>
          <li>
            {t.imageBreaker}: <code>{breakerLabel(backend.breakers?.image?.state, t)}</code>
            {backend.breakers?.image?.retry_after_seconds
              ? ` (${backend.breakers.image.retry_after_seconds}s)`
              : ""}
          </li>
          <li>{t.generations}: {backend.usage?.counters?.generation_requests ?? 0}</li>
          <li>{t.successful}: {backend.usage?.counters?.generation_success ?? 0}</li>
          <li>{t.failed}: {backend.usage?.counters?.generation_failed ?? 0}</li>
          <li>{t.cancelled}: {backend.usage?.counters?.generation_cancelled ?? 0}</li>
          <li>{t.plannerCalls}: {backend.usage?.counters?.planner_calls ?? 0}</li>
          <li>{t.alignmentCalls}: {backend.usage?.counters?.alignment_calls ?? 0}</li>
          <li>{t.imageCalls}: {backend.usage?.counters?.image_calls ?? 0}</li>
          <li className="col-span-2 opacity-70">
            {t.usage}: {t.sinceBackendStart}；{t.caps} {t.runtimeCap} {backend.usage?.caps?.runtime_generations || t.unlimited}、{t.sessionCap} {backend.usage?.caps?.session_generations || t.unlimited}。
          </li>
          <li>{t.uptime}: {backend.uptime_s ?? "—"} 秒</li>
          <li>{t.inFlight}: {backend.in_flight ?? 0}</li>
          <li className="col-span-2 opacity-70">
            {t.version} <code>{backend.version ?? "dev"}</code>
          </li>
        </ul>
      )}

      <h2 className="mt-10 text-xl font-semibold">{t.recentErrors}</h2>
      {recentErrors.length === 0 ? (
        <p className="mt-2 text-sm opacity-70">{t.noErrorsLogged}</p>
      ) : (
        <ul className="mt-3 space-y-2 text-xs">
          {recentErrors.map((e, i) => (
            <li
              key={`${e.trace_id ?? "no-trace"}-${i}`}
              className="rounded-md border border-[var(--color-ink)]/15 bg-white/70 p-2"
            >
              <div className="flex justify-between gap-2">
                <code>{e.kind}</code>
                <span className="opacity-60">{e.ts}</span>
              </div>
              <div className="mt-1 break-words font-mono">{e.message}</div>
              {e.trace_id && (
                <div className="opacity-60">trace {e.trace_id}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-sm">
        {t.operationsDocs}
      </p>
    </main>
  );
}
