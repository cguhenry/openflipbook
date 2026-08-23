import { describe, expect, it, vi } from "vitest";

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
          providers: { fal: true, openrouter: false },
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
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("server-password");
    expect(serialized).not.toContain("provider_envelope");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: { "x-openflipbook-token": "server-only-token" },
      }),
    );
  });
});
