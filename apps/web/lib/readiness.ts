import { pingMongo } from "./db";
import { modalAuthHeaders, modalUrl } from "./modal";
import { probeR2Bucket } from "./r2";

export type ReadinessCode =
  | "BACKEND_UNAVAILABLE"
  | "MONGO_UNAVAILABLE"
  | "MINIO_UNAVAILABLE";

export interface CoreReadiness {
  ok: boolean;
  backend: boolean;
  mongo: boolean;
  minio: boolean;
  code?: ReadinessCode;
}

export interface ReadinessProbes {
  backend: () => Promise<unknown>;
  mongo: () => Promise<unknown>;
  minio: () => Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 3_500;

async function boundedProbe(
  probe: () => Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = Promise.resolve()
    .then(probe)
    .then(() => true, () => false);
  try {
    return await Promise.race([completed, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeBackendHealth(): Promise<void> {
  const baseUrl = process.env.MODAL_API_URL;
  if (!baseUrl) throw new Error("backend_not_configured");
  const response = await fetch(modalUrl(baseUrl, "/health"), {
    method: "GET",
    cache: "no-store",
    headers: modalAuthHeaders(),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("backend_health_failed");
  const payload = await response.json().catch(() => null) as { ok?: unknown } | null;
  if (payload?.ok !== true) throw new Error("backend_health_failed");
}

const DEFAULT_PROBES: ReadinessProbes = {
  backend: probeBackendHealth,
  mongo: pingMongo,
  minio: probeR2Bucket,
};

export async function readCoreReadiness(
  probes: ReadinessProbes = DEFAULT_PROBES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CoreReadiness> {
  const [backend, mongo, minio] = await Promise.all([
    boundedProbe(probes.backend, timeoutMs),
    boundedProbe(probes.mongo, timeoutMs),
    boundedProbe(probes.minio, timeoutMs),
  ]);
  const ok = backend && mongo && minio;
  const code = !backend
    ? "BACKEND_UNAVAILABLE"
    : !mongo
      ? "MONGO_UNAVAILABLE"
      : !minio
        ? "MINIO_UNAVAILABLE"
        : undefined;
  return {
    ok,
    backend,
    mongo,
    minio,
    ...(code ? { code } : {}),
  };
}
