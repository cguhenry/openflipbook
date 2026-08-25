import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifyOwner: vi.fn() }));

vi.mock("@/lib/session-owner", () => ({ verifyOwnerReadonly: mocks.verifyOwner }));
vi.mock("@/lib/modal", () => ({
  modalAuthHeaders: () => ({}),
  modalUrl: (base: string, path: string) => base + path,
}));
vi.mock("@/lib/env", () => ({
  readServerEnv: () => ({ MODAL_API_URL: process.env.MODAL_API_URL }),
}));

import { POST } from "../app/api/related-topics/route";

describe("POST /api/related-topics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards only topic metadata and caps the response at five choices", async () => {
    vi.stubEnv("MODAL_API_URL", "http://backend.test");
    mocks.verifyOwner.mockResolvedValue({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ topics: ["one", "two", "three", "four", "five", "six"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(
      new Request("http://localhost/api/related-topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: "session-a",
          page_title: "Clock tower",
          query: "clock tower",
          output_locale: "zh-TW",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).topics).toEqual(["one", "two", "three", "four", "five"]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      session_id: "session-a",
      page_title: "Clock tower",
      query: "clock tower",
      output_locale: "zh-TW",
      trace_id: expect.any(String),
    });
  });
});
