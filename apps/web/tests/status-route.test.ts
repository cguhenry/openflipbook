import { describe, expect, it, vi } from "vitest";

const readCoreReadiness = vi.hoisted(() => vi.fn().mockResolvedValue({
  ok: true,
  backend: true,
  mongo: true,
  minio: true,
}));

vi.mock("@/lib/readiness", () => ({ readCoreReadiness }));

import { GET } from "../app/api/status/route";

describe("GET /api/status", () => {
  it("allowlists runtime status and never forwards secret-like fields", async () => {
    vi.stubEnv("MODAL_API_URL", "http://backend.test");
    vi.stubEnv("SHARED_TOKEN", "server-only-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          live_provider: "openclaw",
          provider_mode: "live",
          openclaw_connected: true,
          planner_vision_model: "openai/gpt-5.6-luna",
          image_model: "openai/gpt-image-2",
          searxng_connected: false,
          providers: { openclaw: true },
          provider_control: "read_only",
          model_control: "read_only",
          alternate_provider_fallback: false,
          breakers: {
            responses: {
              state: "open",
              consecutive_failures: 3,
              retry_after_seconds: 42,
              failure_threshold: 3,
              cooldown_seconds: 120,
              bearer: "nested-secret",
            },
            image: {
              state: "closed",
              consecutive_failures: 0,
              retry_after_seconds: 0,
              failure_threshold: 3,
              cooldown_seconds: 120,
            },
          },
          usage: {
            scope: "since backend start",
            counters: {
              generation_requests: 4,
              generation_success: 3,
              generation_failed: 1,
              generation_cancelled: 0,
              planner_calls: 4,
              alignment_calls: 3,
              image_calls: 3,
              searxng_searches: 4,
              password: "nested-password",
            },
            caps: { runtime_generations: 0, session_generations: 10 },
            accepted_generations: 4,
            tracked_sessions: 2,
            session_ids: ["must-not-forward"],
          },
          bearer: "server-secret",
          password: "server-password",
          provider_envelope: { token: "hidden" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(payload.openclaw_connected).toBe(true);
    expect(payload.planner_vision_model).toBe("openai/gpt-5.6-luna");
    expect(payload.image_model).toBe("openai/gpt-image-2");
    expect(payload.provider_control).toBe("read_only");
    expect(payload.mongo_connected).toBe(true);
    expect(payload.minio_connected).toBe(true);
    expect(payload.alternate_provider_fallback).toBe(false);
    expect(payload.breakers.responses).toEqual({
      state: "open",
      consecutive_failures: 3,
      retry_after_seconds: 42,
      failure_threshold: 3,
      cooldown_seconds: 120,
    });
    expect(payload.usage.counters.planner_calls).toBe(4);
    expect(payload.usage.caps.session_generations).toBe(10);
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("server-password");
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).not.toContain("nested-password");
    expect(serialized).not.toContain("must-not-forward");
    expect(serialized).not.toContain("provider_envelope");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: { "x-openflipbook-token": "server-only-token" },
      }),
    );
    expect(readCoreReadiness).toHaveBeenCalledTimes(1);
  });
});
