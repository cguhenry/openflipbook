import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeMocks = vi.hoisted(() => ({
  mongo: vi.fn<() => Promise<void>>(),
  minio: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/db", () => ({ pingMongo: probeMocks.mongo }));
vi.mock("@/lib/r2", () => ({ probeR2Bucket: probeMocks.minio }));

import { GET } from "../app/api/ready/route";
import { readCoreReadiness, type ReadinessProbes } from "../lib/readiness";

function passingProbes(): ReadinessProbes {
  return {
    backend: vi.fn().mockResolvedValue(undefined),
    mongo: vi.fn().mockResolvedValue(undefined),
    minio: vi.fn().mockResolvedValue(undefined),
  };
}

describe("core readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probeMocks.mongo.mockResolvedValue(undefined);
    probeMocks.minio.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns 200 only after /health, Mongo ping, and MinIO bucket probe pass", async () => {
    vi.stubEnv("MODAL_API_URL", "http://backend.test/");
    vi.stubEnv("SHARED_TOKEN", "server-only-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, service: "openflipbook" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true, backend: true, mongo: true, minio: true });
    expect(probeMocks.mongo).toHaveBeenCalledTimes(1);
    expect(probeMocks.minio).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://backend.test/health");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "GET",
      headers: { "x-openflipbook-token": "server-only-token" },
    }));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("server-only-token");
    expect(serialized).not.toContain("backend.test");
    expect(serialized).not.toContain("openclaw");
    expect(serialized).not.toContain("searxng");
  });

  it.each([
    ["backend", "BACKEND_UNAVAILABLE"],
    ["mongo", "MONGO_UNAVAILABLE"],
    ["minio", "MINIO_UNAVAILABLE"],
  ] as const)("reports a bounded %s failure without retrying", async (failed, code) => {
    const probes = passingProbes();
    vi.mocked(probes[failed]).mockRejectedValueOnce(new Error("private detail"));

    const result = await readCoreReadiness(probes, 50);

    expect(result.ok).toBe(false);
    expect(result[failed]).toBe(false);
    expect(result.code).toBe(code);
    expect(probes.backend).toHaveBeenCalledTimes(1);
    expect(probes.mongo).toHaveBeenCalledTimes(1);
    expect(probes.minio).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private detail");
  });

  it("fails closed when a probe exceeds its timeout", async () => {
    const probes = passingProbes();
    probes.mongo = vi.fn(() => new Promise<void>(() => undefined));

    const result = await readCoreReadiness(probes, 5);

    expect(result).toEqual({
      ok: false,
      backend: true,
      mongo: false,
      minio: true,
      code: "MONGO_UNAVAILABLE",
    });
    expect(probes.mongo).toHaveBeenCalledTimes(1);
  });

  it("returns a secret-safe 503 when a core dependency fails", async () => {
    vi.stubEnv("MODAL_API_URL", "http://backend.test");
    probeMocks.minio.mockRejectedValueOnce(new Error("secret-key-value"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      ok: false,
      backend: true,
      mongo: true,
      minio: false,
      code: "MINIO_UNAVAILABLE",
    });
    expect(JSON.stringify(payload)).not.toContain("secret-key-value");
  });
});
