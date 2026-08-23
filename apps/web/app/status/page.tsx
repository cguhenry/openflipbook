import { readServerEnv } from "@/lib/env";
import { listRecentErrors } from "@/lib/db";
import { modalAuthHeaders } from "@/lib/modal";

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

function buildRows(env: ReturnType<typeof readServerEnv>): Row[] {
  return [
    {
      key: "MODAL_API_URL",
      required: true,
      ok: Boolean(env.MODAL_API_URL),
      hint: "Internal URL of the OpenFlipbook backend.",
    },
    {
      key: "MONGODB_URI + MONGODB_DB",
      required: true,
      ok: Boolean(env.MONGODB_URI && env.MONGODB_DB),
      hint: "MongoDB connection string + database name for the node graph.",
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
      hint: "Private object storage for generated images and owner backups.",
    },
  ];
}

export default async function StatusPage() {
  const env = readServerEnv();
  const rows = buildRows(env);
  const allRequired = rows.filter((r) => r.required).every((r) => r.ok);

  const [backend, recentErrors] = await Promise.all([
    fetchBackendStatus(),
    env.MONGODB_URI && env.MONGODB_DB
      ? listRecentErrors(20).catch(() => [])
      : Promise.resolve([]),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold">Environment status</h1>
      <p className="mt-2 text-sm opacity-70">
        Checks the server-side env this deploy is running with. Client secrets
        not shown.
      </p>

      <div
        className={`mt-6 rounded-xl border p-4 text-sm ${
          allRequired
            ? "border-green-600 bg-green-50 text-green-900"
            : "border-amber-600 bg-amber-50 text-amber-900"
        }`}
      >
        {allRequired
          ? "All required NAS services are configured."
          : "Some required NAS service configuration is missing."}
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
              {r.ok ? "set" : r.required ? "missing" : "not set"}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-xl font-semibold">Backend health</h2>
      {!backend ? (
        <p className="mt-2 text-sm opacity-70">
          MODAL_API_URL not set; backend health check skipped.
        </p>
      ) : backend.error ? (
        <p className="mt-2 text-sm text-red-700">
          Backend unreachable: {backend.error}
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <li>
            OpenClaw:{" "}
            <span className={backend.openclaw_connected ? "text-green-700" : "text-amber-700"}>
              {backend.openclaw_connected ? "connected" : "unavailable"}
            </span>
          </li>
          <li>
            SearXNG:{" "}
            <span className={backend.searxng_connected ? "text-green-700" : "text-amber-700"}>
              {backend.searxng_connected ? "connected" : "unavailable"}
            </span>
          </li>
          <li>planner/vision: <code>{backend.planner_vision_model ?? "openai/gpt-5.6-luna"}</code></li>
          <li>image: <code>{backend.image_model ?? "openai/gpt-image-2"}</code></li>
          <li>provider: <code>{backend.live_provider ?? "unknown"}</code></li>
          <li>mode: <code>{backend.provider_mode ?? "unknown"}</code>{backend.mock_mode ? " (mock)" : ""}</li>
          <li>
            Mongo:{" "}
            <span className={backend.mongo_connected === false ? "text-amber-700" : "text-green-700"}>
              {backend.mongo_connected === false ? "unavailable" : backend.mongo_connected === true ? "connected" : "configured"}
            </span>
          </li>
          <li>
            MinIO:{" "}
            <span className={backend.minio_connected === false ? "text-amber-700" : "text-green-700"}>
              {backend.minio_connected === false ? "unavailable" : backend.minio_connected === true ? "connected" : "configured"}
            </span>
          </li>
          <li>provider control: <code>read-only</code></li>
          <li>fallback: <code>{backend.alternate_provider_fallback ? "unexpectedly enabled" : "none"}</code></li>
          <li>
            responses breaker: <code>{backend.breakers?.responses?.state ?? "unknown"}</code>
            {backend.breakers?.responses?.retry_after_seconds
              ? ` (${backend.breakers.responses.retry_after_seconds}s)`
              : ""}
          </li>
          <li>
            image breaker: <code>{backend.breakers?.image?.state ?? "unknown"}</code>
            {backend.breakers?.image?.retry_after_seconds
              ? ` (${backend.breakers.image.retry_after_seconds}s)`
              : ""}
          </li>
          <li>generations: {backend.usage?.counters?.generation_requests ?? 0}</li>
          <li>successful: {backend.usage?.counters?.generation_success ?? 0}</li>
          <li>failed: {backend.usage?.counters?.generation_failed ?? 0}</li>
          <li>cancelled: {backend.usage?.counters?.generation_cancelled ?? 0}</li>
          <li>planner calls: {backend.usage?.counters?.planner_calls ?? 0}</li>
          <li>alignment calls: {backend.usage?.counters?.alignment_calls ?? 0}</li>
          <li>image calls: {backend.usage?.counters?.image_calls ?? 0}</li>
          <li className="col-span-2 opacity-70">
            Usage scope: {backend.usage?.scope ?? "since backend start"}; caps runtime {backend.usage?.caps?.runtime_generations || "unlimited"}, session {backend.usage?.caps?.session_generations || "unlimited"}.
          </li>
          <li>uptime: {backend.uptime_s ?? "—"}s</li>
          <li>in-flight: {backend.in_flight ?? 0}</li>
          <li className="col-span-2 opacity-70">
            version <code>{backend.version ?? "dev"}</code>
          </li>
        </ul>
      )}

      <h2 className="mt-10 text-xl font-semibold">Recent errors</h2>
      {recentErrors.length === 0 ? (
        <p className="mt-2 text-sm opacity-70">No errors logged.</p>
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
        See <code>docs/BYO-KEYS.md</code> for the full setup walkthrough.
      </p>
    </main>
  );
}
